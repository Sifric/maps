# OSRM on Cloudflare Workers Free — upstream WebAssembly port

**Status: experimental, not deployed.** This directory tracks a port of the **real** OSRM engine, not a custom route solver and not an OSRM API-shaped proxy.

## Why a port is necessary

The existing OSRM Docker benchmark measures native Linux OSRM, not Cloudflare Workers. Workers cannot execute the native `osrm-routed` Linux binary. A genuine Workers implementation needs the upstream C++ routing core compiled to WebAssembly, plus a Workers-compatible graph loader and HTTP adapter.

## Current implementation

The manually dispatched [OSRM WebAssembly workflow](../../.github/workflows/osrm-workers-wasm.yml) checks out upstream OSRM v5.26.0 and invokes Emscripten/CMake. It preserves compiler diagnostics as artifacts. This is an **initial source-port attempt**, not a claim that OSRM currently builds or runs on Workers.

Upstream OSRM's Boost, TBB, filesystem, mmap and platform-specific dependencies may block configuration or compilation. They must be resolved rather than silently replacing OSRM with a different algorithm.

## Acceptance criteria before any production cutover

1. Compile actual OSRM routing logic for Workers-compatible WebAssembly.
2. Load the full Sri Lanka preprocessed routing graph within a Workers isolate (128 MB), without relying on Linux mmap or native processes.
3. Serve real OSRM `route/v1/driving` responses for Sri Lanka coordinates.
4. Meet Workers Free per-request CPU limits; network wall time is not the same as CPU time.
5. Deploy to a separate preview Worker, verify behavior, and only then consider replacing existing routing.

**No credentials, paid Cloudflare Containers, paid VPS, production changes or automatic deployment are required by this experiment.** A successful Linux Docker test does not prove any of these criteria.
