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
	CPUTempC   float64 `json:"cpu_temp_c"`
	IGPUPct    float64 `json:"igpu_pct"`
	Timestamp  string  `json:"timestamp"`
	TempSource string  `json:"temp_source"`
}

var (
	cacheMu      sync.RWMutex
	cachedResult = MetricsResponse{
		CPUTempC:   -1.0,
		IGPUPct:    -1.0,
		Timestamp:  time.Now().Format(time.RFC3339),
		TempSource: "unavailable",
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

// queryIGPU uses WMI Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine.
// Must be called from a thread with COM initialized.
func queryIGPU() float64 {
	svc, err := connectWMI(`root\cimv2`)
	if err != nil {
		log.Printf("[igpu] WMI connect failed: %v", err)
		return -1.0
	}
	defer svc.Release()

	result, err := oleutil.CallMethod(svc, "ExecQuery",
		`SELECT UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine WHERE Name LIKE "%engtype_3D"`)
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
		return -1.0
	}

	var totalUtil float64
	for i := 0; i < count; i++ {
		item, err := oleutil.CallMethod(resultDisp, "ItemIndex", i)
		if err != nil {
			continue
		}
		itemDisp := item.ToIDispatch()
		utilVal, err := oleutil.GetProperty(itemDisp, "UtilizationPercentage")
		if err == nil {
			totalUtil += toFloat64(utilVal)
		}
		itemDisp.Release()
	}
	return totalUtil
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

		cacheMu.Lock()
		cachedResult = MetricsResponse{
			CPUTempC:   temp,
			IGPUPct:    igpu,
			Timestamp:  time.Now().Format(time.RFC3339),
			TempSource: source,
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
