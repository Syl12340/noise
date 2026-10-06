# Independent noise interface and pitch migration

This directory is a development host and compatibility harness. No production page, recorder, main.js or Worker loads the new core. Mainline calibration and save policies remain application-owned. This migration does not invalidate historical records or require a laboratory calibration to operate the existing application.

## Implemented

The opt-in `noise-wasm/acoustics` feature builds an actual noise cdylib. The host calls Rust-owned NoiseEngine sessions for DC removal, A weighting, energy/windows, FFT/third-octave spectra and idempotent tail completion. The default Phase0A probe remains a separate minimal build.

The opt-in `noise-core/speech` feature ports PCM pre-emphasis, float emphasis, YIN frame estimation and complete-frame pitch tracking. Their first-sample rules remain distinct. Speech methods are currently Rust/native interfaces; this noise ABI does not yet export them. Anti-alias resampling, HNR, LPC/formants and full phonetic pipeline assembly remain later batches.

## Build and verify

Run from the `rs-core` directory using installed Rust targets, Python and Node:

```text
python tools/run-phase2.py
```

This runs 16 checks without regenerating reference data. Reports are in `reports/phase2-verification.json`, `reports/acoustics-p0-wasm-comparison.json`, `reports/pitch-compatibility.json` and `reports/noise-wasm-host.json`. Reference exporters and `extract_noise_serialization.py` are one-time development tools; do not run them as acceptance tests. The comparator rejects changed reference manifest/input hashes.

Noise artifact command and location:

```text
cargo build -p noise-wasm --features acoustics --target wasm32-unknown-unknown --release --locked --offline
target/wasm32-unknown-unknown/release/noise_wasm.wasm
```

The artifact currently has no imports. Node loads bytes through an injected WebAssembly API. A future isolated WX host can supply `WXWebAssembly` and its package-relative WASM path; that loader shape was simulated, not tested on WeChat hardware.

## Host use

```javascript
const { instantiateNoise } = require('./noise-host.cjs');
const host = await instantiateNoise({ api: WebAssembly, source: wasmBytes });
const h = host.create(existingOffset, 128);
let seq = 1;
for (const pcm of recordedInt16Chunks) {
  const { receipt, snapshot } = host.process(h, seq, pcm, true);
  seq = snapshot.seq; // Empty/terminated chunks do not blindly advance sequence.
  let event;
  while ((event = host.nextEvent(h)) !== null) consumeEvent(event);
}
const summary = host.finish(h);
host.destroy(h);
```

`existingOffset` is an explicitly supplied numeric offset; it is not evidence of physical calibration. The host's default 100 exists for baseline fixture compatibility only. Any later application adapter must pass the existing calibration/estimate offset and preserve its labels, provenance and permitted saving behavior.

The shared input staging buffer belongs to WASM and accepts at most 262144 Int16 samples per call. Host methods copy input before processing and copy/decode output before acknowledging. Keep one host owner for each WASM instance; low-level export calls are intended for ABI testing, not independent concurrent consumers.

## ABI status and operations

| Export / group | Role |
| --- | --- |
| `noise_abi_version`, `noise_input_capacity` | ABI1 identity; fixed input capacity |
| `noise_input_ptr` | WASM-owned staging location; reacquire memory view |
| `noise_create(offset, capacity)` | Four simultaneous sessions; monotonic handles; returns 0 on failure |
| `noise_process(handle, seq, len, needed)` | Produce receipt plus full snapshot |
| `noise_snapshot`, `noise_query` | Read state or current spectrum; do not advance DSP clock |
| `noise_next_event` | Transfer one window or spectrum, or null |
| `noise_finish(handle, invalid)` | Cached, idempotent completion |
| `noise_invalidate(handle, reason)` | Codes 0 format, 1 interruption, 2 stop timeout, 3 discontinuity |
| `noise_destroy` | Release session; old handle can never refer to a new session |
| `noise_result_ptr/len`, `noise_has_result`, `noise_ack` | Shared pending-result protocol |
| `noise_last_status` | Detailed failure for create returning 0 |

| Status | Meaning |
| --- | --- |
| 0 | Success |
| -1 | Stale/missing handle |
| -2 | Invalid argument/staging length |
| -3 | Pending result or event queue backpressure |
| -4 | Wrong/overflowing sequence |
| -5 | This block intrinsically needs more events than configured capacity |
| -6 | Four sessions already live or handle space exhausted |

Drain queued events on event backpressure, then retry the same uncommitted sequence. A block with status -5 needs a larger event capacity or an explicitly planned input contract; automatic splitting can change whole-chunk quality rejection semantics. Do not automatically split or replay. Any WASM trap, malformed memory range or committed-result decoding failure discards the host instance. Recovery requires a new instance and a new recording session; this host never concatenates recovery data onto an existing result or switches DSP backend.

Wire numbers are JSON numbers or the strings `NaN`, `+Infinity`, `-Infinity`. Preserve these classes explicitly in consumers. Internal strings are bounded ASCII reason/state names; application display messages stay outside the core. Input/output views can be detached by memory growth and must not be retained between calls. The result slot is global: while pending, operations on every session reject without overwriting it. Result size is bounded at 2 MiB; oversize is a fatal instance failure rather than recoverable partial output.

## Limits

Numerical compatibility is not proof of laboratory accuracy, recorder-chain integrity or clinical validity. Real WXWebAssembly, Worker operation, Android recording, mobile latency/memory and long-session stress remain unverified. Full snapshots and JSON spectra intentionally favor inspectability in this independent interface; transfer overhead and event queue memory must be assessed before production integration. Known baseline F0/formant validation failures are retained, not repaired by this port.
