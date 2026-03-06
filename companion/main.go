// companion/main.go — TabVolt Local Telemetry Companion
// Single file Go program. Serves hardware metrics on :9001
// PHASE 2

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// MetricsResponse is the JSON contract with the extension
type MetricsResponse struct {
	CPUTempC   float64 `json:"cpu_temp_c"`
	IGPUPct    float64 `json:"igpu_pct"`
	Timestamp  string  `json:"timestamp"`
	TempSource string  `json:"temp_source"`
}

var (
	cacheMu      sync.Mutex
	cachedResult MetricsResponse
)

func init() {
	// Default cached values — both unavailable
	cachedResult = MetricsResponse{
		CPUTempC:   -1.0,
		IGPUPct:    -1.0,
		Timestamp:  time.Now().Format(time.RFC3339),
		TempSource: "unavailable",
	}
}

// connectWMI creates a WMI service connection to the given namespace.
// Returns the service IDispatch or nil on error.
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

// queryCPUTemp uses WMI MSAcpi_ThermalZoneTemperature (root\wmi)
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
	count := int(countVar.Val)
	if count == 0 {
		log.Println("[temp] No thermal zones found")
		return -1.0, "unavailable"
	}

	// Take first thermal zone
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

	// Value is in tenths of Kelvin
	raw := toFloat64(tempVal)
	if raw == 0 {
		return -1.0, "unavailable"
	}

	celsius := (raw / 10.0) - 273.15
	log.Printf("[temp] Raw=%v  Celsius=%.1f", raw, celsius)
	return celsius, "acpi_thermal_zone"
}

// queryIGPU uses WMI Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
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
		log.Println("[igpu] No GPU engine entries found")
		return -1.0
	}

	log.Printf("[igpu] Found %d 3D engine entries", count)
	var totalUtil float64
	for i := 0; i < count; i++ {
		item, err := oleutil.CallMethod(resultDisp, "ItemIndex", i)
		if err != nil {
			continue
		}
		itemDisp := item.ToIDispatch()
		utilVal, err := oleutil.GetProperty(itemDisp, "UtilizationPercentage")
		if err == nil {
			v := toFloat64(utilVal)
			totalUtil += v
		}
		itemDisp.Release()
	}

	log.Printf("[igpu] Total utilization: %.1f%%", totalUtil)
	return totalUtil
}

// toFloat64 extracts a numeric value from a VARIANT, handling all common WMI numeric types.
func toFloat64(v *ole.VARIANT) float64 {
	if v == nil {
		return 0
	}
	val := v.Value()
	if val == nil {
		// Fall back to raw Val field
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
		// Last resort: use the raw Val field
		return float64(v.Val)
	}
}

// collectMetrics runs both WMI queries on a dedicated, COM-initialized OS thread.
// Times out after 3 seconds on first call, returning cached values.
func collectMetrics() MetricsResponse {
	type result struct {
		temp   float64
		source string
		igpu   float64
	}

	ch := make(chan result, 1)
	go func() {
		// CRITICAL: Pin this goroutine to a single OS thread.
		// COM is per-thread on Windows; without this, goroutine migration
		// between threads breaks all WMI/OLE calls.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED)
		defer ole.CoUninitialize()

		temp, source := queryCPUTemp()
		igpu := queryIGPU()
		ch <- result{temp, source, igpu}
	}()

	select {
	case r := <-ch:
		resp := MetricsResponse{
			CPUTempC:   r.temp,
			IGPUPct:    r.igpu,
			Timestamp:  time.Now().Format(time.RFC3339),
			TempSource: r.source,
		}
		cacheMu.Lock()
		cachedResult = resp
		cacheMu.Unlock()
		return resp
	case <-time.After(3 * time.Second):
		log.Println("[metrics] WMI queries timed out (3s), returning cached values")
		cacheMu.Lock()
		cached := cachedResult
		cacheMu.Unlock()
		cached.Timestamp = time.Now().Format(time.RFC3339)
		return cached
	}
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	// CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == "OPTIONS" {
		w.WriteHeader(200)
		return
	}

	metrics := collectMetrics()
	json.NewEncoder(w).Encode(metrics)
}

func main() {
	http.HandleFunc("/metrics", metricsHandler)

	// Graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Println("TabVolt companion running on :9001")
		if err := http.ListenAndServe(":9001", nil); err != nil {
			log.Fatal(err)
		}
	}()

	<-stop
	fmt.Println("\nShutting down TabVolt companion.")
}
