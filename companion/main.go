// companion/main.go — TabVolt Local Telemetry Companion
// Single-file Go program. Serves hardware metrics on 127.0.0.1:9001.
//
// Design:
//   - One dedicated collector goroutine, pinned to an OS thread with COM
//     initialized once, polls WMI every collectInterval and updates a cache.
//   - HTTP requests only ever read the cache, so /metrics responds in
//     microseconds regardless of how slow WMI is.
//   - Listens on loopback only, and CORS is restricted to extension origins —
//     arbitrary websites cannot use this server as a hardware fingerprint
//     oracle.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	listenAddr      = "127.0.0.1:9001"
	collectInterval = 5 * time.Second
)

// MetricsResponse is the JSON contract with the extension.
type MetricsResponse struct {
	CPUTempC      float64 `json:"cpu_temp_c"`
	IGPUPct       float64 `json:"igpu_pct"`
	Timestamp     string  `json:"timestamp"`
	TempSource    string  `json:"temp_source"`
	BrowserCPUPct float64 `json:"browser_cpu_pct"` // -1 if unavailable
	BrowserMemMB  float64 `json:"browser_mem_mb"`  // -1 if unavailable
	BrowserSource string  `json:"browser_source"`  // "wmi_process" | "unavailable"
}

var (
	cacheMu      sync.RWMutex
	cachedResult = MetricsResponse{
		CPUTempC:      -1.0,
		IGPUPct:       -1.0,
		Timestamp:     time.Now().Format(time.RFC3339),
		TempSource:    "unavailable",
		BrowserCPUPct: -1.0,
		BrowserMemMB:  -1.0,
		BrowserSource: "unavailable",
	}
)

// connectWMI creates a WMI service connection to the given namespace.
func connectWMI(namespace string) (*ole.IDispatch, error) {
	unknown, err := oleutil.CreateObject("WbemScripting.SWbemLocator")
	if err != nil {
		return nil, fmt.Errorf("create SWbemLocator: %w", err)
	}
	defer unknown.Release()

	wmi, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return nil, fmt.Errorf("QueryInterface: %w", err)
	}
	defer wmi.Release()

	service, err := oleutil.CallMethod(wmi, "ConnectServer", nil, namespace)
	if err != nil {
		return nil, fmt.Errorf("ConnectServer %s: %w", namespace, err)
	}
	return service.ToIDispatch(), nil
}

// queryCPUTemp uses WMI MSAcpi_ThermalZoneTemperature (root\wmi).
// Must be called from a thread with COM initialized.
func queryCPUTemp() (float64, string) {
	svc, err := connectWMI(`root\wmi`)
	if err != nil {
		log.Printf("[temp] WMI connect failed: %v", err)
		return -1.0, "unavailable"
	}
	defer svc.Release()

	result, err := oleutil.CallMethod(svc, "ExecQuery",
		"SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature")
	if err != nil {
		log.Printf("[temp] ExecQuery failed: %v", err)
		return -1.0, "unavailable"
	}
	resultDisp := result.ToIDispatch()
	defer resultDisp.Release()

	countVar, err := oleutil.GetProperty(resultDisp, "Count")
	if err != nil {
		log.Printf("[temp] Count failed: %v", err)
		return -1.0, "unavailable"
	}
	if int(countVar.Val) == 0 {
		log.Println("[temp] No thermal zones found")
		return -1.0, "unavailable"
	}

	item, err := oleutil.CallMethod(resultDisp, "ItemIndex", 0)
	if err != nil {
		log.Printf("[temp] ItemIndex failed: %v", err)
		return -1.0, "unavailable"
	}
	itemDisp := item.ToIDispatch()
	defer itemDisp.Release()

	tempVal, err := oleutil.GetProperty(itemDisp, "CurrentTemperature")
	if err != nil {
		log.Printf("[temp] GetProperty failed: %v", err)
		return -1.0, "unavailable"
	}

	// Value is in tenths of Kelvin.
	raw := toFloat64(tempVal)
	if raw == 0 {
		return -1.0, "unavailable"
	}
	return (raw / 10.0) - 273.15, "acpi_thermal_zone"
}

// gpuEngineRow is one row of Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine.
type gpuEngineRow struct {
	name    string
	utilPct float64
}

// gpu3DEngineSuffix is the fixed suffix WMI appends to every 3D-engine
// instance name (one per process actively using Direct3D on that engine),
// e.g. "pid_1234_luid_0x...  _phys_0_eng_0_engtype_3D".
const gpu3DEngineSuffix = "engtype_3d"

// sumGPUEngineUtilization sums UtilizationPercentage across every row whose
// instance name identifies it as a 3D engine, ignoring Copy/VideoDecode/
// VideoEncode/etc. engines exposed by the same WMI class. Pure and WMI-free
// so it's unit-testable (see main_test.go) — same pattern as
// aggregateBrowserProcesses below, and for the same reason: see that
// function's comment for why the filtering happens here instead of in the
// WQL WHERE clause.
func sumGPUEngineUtilization(rows []gpuEngineRow) (totalPct float64, matched int) {
	for _, r := range rows {
		if !strings.HasSuffix(strings.ToLower(r.name), gpu3DEngineSuffix) {
			continue
		}
		totalPct += r.utilPct
		matched++
	}
	return totalPct, matched
}

// queryIGPU uses WMI Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine.
// Must be called from a thread with COM initialized.
func queryIGPU() float64 {
	svc, err := connectWMI(`root\cimv2`)
	if err != nil {
		log.Printf("[igpu] WMI connect failed: %v", err)
		return -1.0
	}
	defer svc.Release()

	// No WHERE clause — see queryBrowserTotals for why WQL filtering
	// against this same family of synthetic Perf classes isn't trusted
	// here. Fetch every GPU engine instance and filter client-side.
	result, err := oleutil.CallMethod(svc, "ExecQuery",
		"SELECT Name, UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine")
	if err != nil {
		log.Printf("[igpu] ExecQuery failed: %v", err)
		return -1.0
	}
	resultDisp := result.ToIDispatch()
	defer resultDisp.Release()

	countVar, err := oleutil.GetProperty(resultDisp, "Count")
	if err != nil {
		log.Printf("[igpu] Count failed: %v", err)
		return -1.0
	}
	count := int(countVar.Val)
	if count == 0 {
		log.Println("[igpu] WMI returned zero GPU engine instances total — no GPU scheduler (WDDM) perf counters on this system?")
		return -1.0
	}

	rows := make([]gpuEngineRow, 0, count)
	for i := 0; i < count; i++ {
		item, err := oleutil.CallMethod(resultDisp, "ItemIndex", i)
		if err != nil {
			continue
		}
		itemDisp := item.ToIDispatch()

		nameVal, _ := oleutil.GetProperty(itemDisp, "Name")
		utilVal, _ := oleutil.GetProperty(itemDisp, "UtilizationPercentage")

		name := ""
		if nameVal != nil {
			if s, ok := nameVal.Value().(string); ok {
				name = s
			}
		}
		rows = append(rows, gpuEngineRow{name: name, utilPct: toFloat64(utilVal)})
		itemDisp.Release()
	}

	total, matched := sumGPUEngineUtilization(rows)
	if matched == 0 {
		log.Printf("[igpu] %d GPU engine instances total, none were 3D engines", count)
	}
	return total
}

// browserProcessNamePrefix matches every instance WMI reports for the
// browser's own process tree (renderer, GPU, network, utility processes
// all run as separate "chrome.exe" instances, which WMI's per-process
// counters de-duplicate as "chrome", "chrome#1", "chrome#2", ...).
const browserProcessNamePrefix = "chrome"

// processRow is one row of Win32_PerfFormattedData_PerfProc_Process.
type processRow struct {
	name       string
	cpuPct     float64 // PercentProcessorTime — already normalized to "% of total system CPU"
	workingSet float64 // WorkingSetPrivate, in bytes — matches Task Manager's own "Memory" column
}

// aggregateBrowserProcesses sums CPU% and private working-set memory across
// every row belonging to the browser, giving its real total system-wide
// footprint instead of an assumed percentage. Pure and WMI-free so it's
// unit-testable without Windows (see main_test.go).
//
// The matching happens here, in Go, rather than in the WQL WHERE clause
// queryBrowserTotals sends to WMI: server-side `LIKE` filtering against
// Win32_PerfFormattedData_* classes (synthetic "cooked" performance
// classes, not real CIM instances) is unreliable across Windows
// versions/providers and has been observed to silently return zero rows
// instead of filtering — the class-level query without a WHERE clause is
// the one part that's dependable, so that's the only thing WMI is asked
// to do.
func aggregateBrowserProcesses(rows []processRow) (cpuPct float64, memBytes float64, matched int) {
	for _, r := range rows {
		if !strings.HasPrefix(strings.ToLower(r.name), browserProcessNamePrefix) {
			continue
		}
		cpuPct += r.cpuPct
		memBytes += r.workingSet
		matched++
	}
	return cpuPct, memBytes, matched
}

// queryBrowserTotals sums CPU% and private working-set memory across every
// chrome.exe process WMI can see system-wide (main browser process, every
// renderer/site-isolation instance, the GPU process, network process,
// etc.) — the real total the browser is using, not a guessed fraction of
// the system total. Must be called from a thread with COM initialized.
func queryBrowserTotals() (cpuPct float64, memMB float64, ok bool) {
	svc, err := connectWMI(`root\cimv2`)
	if err != nil {
		log.Printf("[browser] WMI connect failed: %v", err)
		return -1, -1, false
	}
	defer svc.Release()

	result, err := oleutil.CallMethod(svc, "ExecQuery",
		"SELECT Name, PercentProcessorTime, WorkingSetPrivate FROM Win32_PerfFormattedData_PerfProc_Process")
	if err != nil {
		log.Printf("[browser] ExecQuery failed: %v", err)
		return -1, -1, false
	}
	resultDisp := result.ToIDispatch()
	defer resultDisp.Release()

	countVar, err := oleutil.GetProperty(resultDisp, "Count")
	if err != nil {
		log.Printf("[browser] Count failed: %v", err)
		return -1, -1, false
	}
	count := int(countVar.Val)
	if count == 0 {
		log.Println("[browser] WMI returned zero process instances total — the Process performance counter category may be disabled on this machine. Try running `lodctr /r` in an elevated command prompt to rebuild it, then restart the companion.")
		return -1, -1, false
	}

	rows := make([]processRow, 0, count)
	for i := 0; i < count; i++ {
		item, err := oleutil.CallMethod(resultDisp, "ItemIndex", i)
		if err != nil {
			continue
		}
		itemDisp := item.ToIDispatch()

		nameVal, _ := oleutil.GetProperty(itemDisp, "Name")
		cpuVal, _ := oleutil.GetProperty(itemDisp, "PercentProcessorTime")
		memVal, _ := oleutil.GetProperty(itemDisp, "WorkingSetPrivate")

		name := ""
		if nameVal != nil {
			if s, ok := nameVal.Value().(string); ok {
				name = s
			}
		}
		rows = append(rows, processRow{
			name:       name,
			cpuPct:     toFloat64(cpuVal),
			workingSet: toFloat64(memVal),
		})
		itemDisp.Release()
	}

	totalCPU, totalMemBytes, matched := aggregateBrowserProcesses(rows)
	if matched == 0 {
		log.Printf("[browser] %d process instances total, none named %q — is the browser installed under a different process name?", count, browserProcessNamePrefix)
		return -1, -1, false
	}
	return totalCPU, totalMemBytes / 1048576, true
}

// toFloat64 extracts a numeric value from a VARIANT, handling all common WMI numeric types.
func toFloat64(v *ole.VARIANT) float64 {
	if v == nil {
		return 0
	}
	val := v.Value()
	if val == nil {
		return float64(v.Val)
	}
	switch n := val.(type) {
	case int:
		return float64(n)
	case int8:
		return float64(n)
	case int16:
		return float64(n)
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	case uint8:
		return float64(n)
	case uint16:
		return float64(n)
	case uint32:
		return float64(n)
	case uint64:
		return float64(n)
	case float32:
		return float64(n)
	case float64:
		return n
	case string:
		var f float64
		fmt.Sscanf(n, "%f", &f)
		return f
	case bool:
		if n {
			return 1
		}
		return 0
	default:
		return float64(v.Val)
	}
}

// collectLoop runs forever on a single COM-initialized OS thread, refreshing
// the metrics cache every collectInterval. COM is per-thread on Windows;
// LockOSThread prevents goroutine migration from breaking OLE calls.
func collectLoop(ctx context.Context) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		log.Printf("[metrics] CoInitializeEx failed: %v", err)
		return
	}
	defer ole.CoUninitialize()

	ticker := time.NewTicker(collectInterval)
	defer ticker.Stop()

	for {
		temp, source := queryCPUTemp()
		igpu := queryIGPU()
		browserCPU, browserMemMB, browserOK := queryBrowserTotals()
		browserSource := "unavailable"
		if browserOK {
			browserSource = "wmi_process"
		} else {
			browserCPU, browserMemMB = -1.0, -1.0
		}

		cacheMu.Lock()
		cachedResult = MetricsResponse{
			CPUTempC:      temp,
			IGPUPct:       igpu,
			Timestamp:     time.Now().Format(time.RFC3339),
			TempSource:    source,
			BrowserCPUPct: browserCPU,
			BrowserMemMB:  browserMemMB,
			BrowserSource: browserSource,
		}
		cacheMu.Unlock()

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// setCORS allows extension origins only. Requests without an Origin header
// (curl, same-machine tools) work fine without CORS headers.
func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if strings.HasPrefix(origin, "chrome-extension://") ||
		strings.HasPrefix(origin, "moz-extension://") {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	}
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	cacheMu.RLock()
	metrics := cachedResult
	cacheMu.RUnlock()
	json.NewEncoder(w).Encode(metrics)
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go collectLoop(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", metricsHandler)

	server := &http.Server{
		Addr:         listenAddr,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("TabVolt companion running on %s", listenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-stop
	fmt.Println("\nShutting down TabVolt companion.")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
