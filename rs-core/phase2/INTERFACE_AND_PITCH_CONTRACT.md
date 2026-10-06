# Independent interface and pitch port, v1

Production JavaScript and frozen phase0/phase1 artifacts are immutable. This is an experimental opt-in port, not production integration or new scientific validation.

## Noise interface

Feature `acoustics` in noise-wasm enables std and the already verified noise-core engine. Default probe behavior must remain unchanged. ABI prefix `noise_`, version 1; exports are compiled only for single-thread wasm32. Implement owned Rust registry separately for native testing. Four sessions maximum; monotonically increasing nonzero u32 handles, never reuse a destroyed handle. Reject invalid capacity (1..128), nonfinite calibration offset, stale handles and sequence errors without changing engine state.

Single fixed WASM-owned i16 input staging area, capacity 262144, exposed pointer and capacity. No arbitrary host pointers, malloc/free or shared memory. Bounds check before slicing. Process takes handle, sequence, length and spectrum-needed flag (0/1). Empty/terminated semantics remain those of NoiseEngine, within staging bounds.

Each operation returns a status: success 0, invalid handle -1, invalid argument -2, pending result/backpressure -3, sequence failure -4, intrinsic event capacity -5, registry full/handle exhaustion -6. One result slot per registry, pending until explicit acknowledgment. Operations that would produce or mutate anything must reject while a result is pending, even on another handle. Export result pointer/length and acknowledgment. Returned JSON is UTF-8, represents nonfinite numbers as strings `NaN`, `+Infinity`, `-Infinity` (the phase1 wire spelling). Acknowledge only after copying and decoding. Never retry a committed process after result decoding fails: discard the instance. Maximum result size 2 MiB; no silent truncation.

Create returns a handle (0 on failure), destroy returns status. Process returns a JSON object with receipt and full snapshot. Snapshot/read query, spectrum query, finish (normal/invalid), hard-invalid (bounded reason code), and next-event each publish one result. Next-event returns one window/spectrum or null, popping only when serialization succeeds. Result publication after mutation cannot report a recoverable serialization failure; all structurally possible outputs must fit the bound, otherwise trap and discard instance. No unbounded user-controlled strings. Finish stays idempotent. Registry must provide meaningful native tests of ownership, pending acknowledgments, stale handles, invalid input and isolation.

Host must support injected Node WebAssembly and WXWebAssembly loaders without requiring global WebAssembly/instanceof/TextDecoder. Reacquire typed views after calls that can grow memory. Validate identity, imports, exports, pointer ranges and alignment. Trap poisons instance; no automatic replay or switching DSP backend. No loading, recording or page changes in production.

## Speech first batch

Feature `speech` depends on `acoustics` to use std. Port `utils/phonetic/pre-emphasis.js`, `resample.js` emphasis only, and `yin-pitch.js`. Do not port resampling kernels, HNR or formants in this batch. Keep two distinct first-sample formulas for PCM pre-emphasis and float emphasis. Float32 output stores and ordered Float64 arithmetic must match JavaScript. YIN uses centered fixed-length comparisons, support-energy gate, CMNDF minima, raw difference parabola, candidate selection, shorter-period exclusion and boundary rules exactly as source. Expose frame and track methods with explicit optional fields. Reject nonpositive frame size/hop and invalid track configuration rather than hanging; document this bounded API difference.

Before Rust comparisons, freeze JS reference cases. For valid finite input, pre-emphasis Float32 bits and YIN Float64 output bits must be exact; all reason strings, presence/absence of optional fields, time/frame count and flags exact. No post-hoc tolerance widening. If equality fails, investigate source/rounding and report rather than claiming scientific equivalence. Use explicit cases near range boundaries, silence, short frames, high-frequency aliases, discontinuous/DC and low energy. Existing upstream scientific failures are not fixed by a faithful port.

## Acceptance

Build actual opt-in cdylib for wasm32-unknown-unknown and execute it under Node, inspecting imports. Run registry/host failure tests and compare representative sessions to the native core, including spectra. Speech tests compare against actual baseline JS independently, not hand-reimplemented expectations. Re-run phase1 numerical/isolation guard and default probe checks. Device WXWebAssembly/Worker performance, recording-chain verification and speech pipeline scientific validation remain open.
