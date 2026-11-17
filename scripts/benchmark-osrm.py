#!/usr/bin/env python3
"""Measure OSRM RSS and concurrent Sri Lanka routing latency without external traffic."""
import concurrent.futures
import json
import os
import statistics
import time
import urllib.request

PID = int(open("osrm.pid").read().strip())
BASE = "http://127.0.0.1:5000"
ROUTES = [
    (81.7245, 7.6803, 81.7260, 7.6830), # Kattankudy
    (81.6924, 7.7102, 81.7020, 7.7210), # Batticaloa
    (79.8612, 6.9271, 79.8750, 6.9100), # Colombo
    (80.6337, 7.2906, 80.6510, 7.3010), # Kandy
    (80.2170, 6.0535, 80.2350, 6.0600), # Galle
    (80.0240, 9.6615, 80.0410, 9.6750), # Jaffna
]

def mem():
    result = {}
    with open(f"/proc/{PID}/status") as f:
        for line in f:
            if line.startswith(("VmRSS:", "VmHWM:", "VmSize:")):
                k, v = line.split(":", 1)
                result[k] = int(v.strip().split()[0]) / 1024
    return result

def request(i):
    a,b,c,d = ROUTES[i % len(ROUTES)]
    url = f"{BASE}/route/v1/driving/{a},{b};{c},{d}?overview=false&steps=true"
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=25) as response:
            data = json.load(response)
        return {"ok": data.get("code") == "Ok", "ms": (time.perf_counter()-start)*1000, "code": data.get("code")}
    except Exception as e:
        return {"ok": False, "ms": (time.perf_counter()-start)*1000, "error": str(e)}

for attempt in range(120):
    try:
        with urllib.request.urlopen(BASE + "/nearest/v1/driving/81.7245,7.6803", timeout=2) as response:
            if json.load(response).get("code") == "Ok":
                break
    except Exception:
        time.sleep(1)
else:
    raise RuntimeError("OSRM failed to become ready")

report = {"idle_memory_mb": mem(), "runs": []}
for concurrency in [1, 10, 25, 50, 100]:
    count = max(100, concurrency * 5)
    before = mem()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(request, i) for i in range(count)]
        results = [f.result() for f in futures]
    after = mem()
    latencies = sorted(x["ms"] for x in results)
    success = sum(x["ok"] for x in results)
    row = {
        "concurrency": concurrency, "requests": count, "success": success,
        "failures": count-success, "p50_ms": round(statistics.median(latencies), 2),
        "p95_ms": round(latencies[min(len(latencies)-1, int(len(latencies)*.95))], 2),
        "memory_before_mb": before, "memory_after_mb": after,
    }
    print(json.dumps(row), flush=True)
    report["runs"].append(row)
report["final_memory_mb"] = mem()
with open("osrm-results.json", "w") as f:
    json.dump(report, f, indent=2)
