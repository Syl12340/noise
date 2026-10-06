# Speech WASM and resampling port v1

Scope: independent rs-core only, no production integration. Preserve phase0/1/2 frozen fixtures, manifests and numerical budgets. Push only reviewed source, necessary frozen data and reports; do not include target, _work, private configuration or unrelated files.

## Resampling

Port actual baseline resampleLowPass, supporting input rates 12000,16000,22050,24000,32000,44100,48000 -> 12000 Hz with cutoff 5500 Hz in this batch. Other profiles explicitly return unsupported; no approximate fallback. Freeze normalized 257-tap Blackman/sinc kernels by observing the actual JavaScript Map.set calls across maximum input length262144. Capture every observed quantized phase, including phase1 if observed; do not approximate a missing phase with phase0. The supported rational rate ratios have no phase1 within this input domain.

Output length floor(n*out/in), positions i*in/out, base floor(position), phase round((position-base)*1e6)/1e6, ordered Float64 edge-held convolution and Float32 output stores must match. Maximum input262144. Finite signal and supported positive rates only; empty returns empty. Rust uses captured normalized coefficients, never regenerates transcendentals at runtime. Every stored f32 bit and output length must match baseline on frozen finite fixtures; do not widen tolerances after comparison. Capture kernel phases required by baseline legal maximum recording duration; explicitly reject any missing phase.

## Stateless speech ABI1

Feature noise-wasm/speech enables noise-core/speech and std. Separate speech_ prefix, isolated owned registry, no application/recording import. One pending result, ack required, no replays after traps/decoding failures. Fixed staging: i16/f32 up to262144, f64 frames up to4096. Expose bounded JSON PitchFrame/track (optional properties exact) and owned binary f32 output for emphasis/resampling, copying before ack. Reject input length/config before DSP. Track requires positive finite fs, positive frame/hop, frame<=4096, at most4096 frames and at most150million centered comparison pairs per synchronous track call; explicit capacity rejection, never partial output. Preserve baseline frame result for supported valid configs. Invalid/nonfinite track inputs rejected. Host honors legacy hopSize and hop alias, rejecting conflicting aliases and unknown pitch options. Host validates integer arguments before WASM i32 coercion, reacquires views on memory growth, accepts injected WX loader shape without global WebAssembly/TextDecoder, discards on instance faults. No backend fallback. One host owner per instance; never attach independent noise and speech hosts to the same instance.

## Acceptance

Freeze actual-JS finite reference fixtures and SHA identities before comparisons. Native and actual WASM comparisons share these references; pitch reuses phase2 exact rule and fixtures. Run boundary/pending/trap/view tests, existing default-probe and noise regressions, production isolation guard. Numerical compatibility is not new scientific validity or real WX/Worker performance verification. Calibration/historical record policies remain outside this core.
