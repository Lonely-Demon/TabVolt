// main_test.go — unit tests for the WMI-free, pure aggregation logic.
// Run with: go test ./...
//
// The WMI queries themselves (queryCPUTemp, queryIGPU, queryBrowserTotals)
// call into Windows COM and can only be exercised on real Windows hardware.
// aggregateBrowserProcesses is deliberately factored out as a pure function
// over plain structs so the summing logic — the part a bug is actually
// likely to hide in — is verifiable on any platform, including this repo's
// Linux CI/dev environment.
package main

import "testing"

func TestAggregateBrowserProcesses(t *testing.T) {
	t.Run("no rows", func(t *testing.T) {
		cpu, mem, n := aggregateBrowserProcesses(nil)
		if cpu != 0 || mem != 0 || n != 0 {
			t.Fatalf("got (%v, %v, %v), want (0, 0, 0)", cpu, mem, n)
		}
	})

	t.Run("sums every chrome.exe instance, case-insensitively", func(t *testing.T) {
		rows := []processRow{
			{name: "chrome", cpuPct: 5.0, workingSet: 200 * 1024 * 1024},
			{name: "chrome#1", cpuPct: 3.5, workingSet: 150 * 1024 * 1024},
			{name: "Chrome#2", cpuPct: 1.0, workingSet: 80 * 1024 * 1024},
		}
		cpu, mem, n := aggregateBrowserProcesses(rows)
		if n != 3 {
			t.Fatalf("matched = %d, want 3", n)
		}
		wantCPU := 5.0 + 3.5 + 1.0
		if cpu != wantCPU {
			t.Fatalf("cpu = %v, want %v", cpu, wantCPU)
		}
		wantMem := float64(200+150+80) * 1024 * 1024
		if mem != wantMem {
			t.Fatalf("mem = %v, want %v", mem, wantMem)
		}
	})

	t.Run("ignores unrelated processes", func(t *testing.T) {
		rows := []processRow{
			{name: "chrome", cpuPct: 4.0, workingSet: 100 * 1024 * 1024},
			{name: "explorer", cpuPct: 50.0, workingSet: 999 * 1024 * 1024},
			{name: "_Total", cpuPct: 999.0, workingSet: 999 * 1024 * 1024},
			{name: "Idle", cpuPct: 999.0, workingSet: 0},
		}
		cpu, _, n := aggregateBrowserProcesses(rows)
		if n != 1 {
			t.Fatalf("matched = %d, want 1 (only the chrome.exe row)", n)
		}
		if cpu != 4.0 {
			t.Fatalf("cpu = %v, want 4.0 — an unrelated process leaked into the sum", cpu)
		}
	})

	t.Run("does not fuzzy-match names that merely contain the prefix elsewhere", func(t *testing.T) {
		// "somechrome" does not start with "chrome" and must not match —
		// this is a prefix check, not a substring check.
		rows := []processRow{{name: "somechrome", cpuPct: 10.0, workingSet: 1}}
		_, _, n := aggregateBrowserProcesses(rows)
		if n != 0 {
			t.Fatalf("matched = %d, want 0", n)
		}
	})
}
