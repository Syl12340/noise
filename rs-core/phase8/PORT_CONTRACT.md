# Offline PCM quality/centering ABI and PCM-to-HNR orchestration v1

Independent rs-core only. Reuse the actual Rust acoustics quality implementation;
do not create a second inspector/centering algorithm. Offline inspect uses a fresh
PcmQualityInspector at the supplied source rate for each continuous segment.
Supported rates12000/16000/22050/24000/32000/44100/48000, PCM<=262144 samples.
Empty input is valid for primitive inspect/center, not for the recording pipeline.

Expose inspectPcm(pcm,rate) with exactly baseline inspectPcm fields and clipping
evidence; centerPcm(pcm) with f32 stores bit-exact to centeredSignal. Preserve rail
counts, sliding10ms window/merged intervals, isolated rail distinction, near-full
scale threshold32112, digital-silence/no-AC semantics and plateau-as-warning.
Center using ordered full-segment f64 mean then (sample-mean)/32768 into f32.
No blockwise mean subtraction for a continuous stream; this is offline analysis.

Shared speech staging, bounded JSON/binary results and pending/copy/ack/trap rules
apply. Reject capacity/rate before inspecting or publishing output. No calibration
state, recording permissions, saving rules or historical records in these APIs.

analyzePcmHnr(pcm,options,hooks) owns PCM and boundaries before its first await.
Options: sampleRate(default44100), discontinuityBoundariesSeconds(Float64Array).
Use the existing fixed recording profile: <=5.25seconds and262144 samples,
12000Hz analysis, cutoff5500, YIN1024/120/0.1/40..1200, HNR required pitch/.2/.15.
Rust plans cuts; each independent source span is inspected, centered, resampled
and tracked before quality-qualified evidence/HNR/assembly through phase7.
Host coordinates calls and yields only; it does not implement DSP or interval math.

Return assembled HNR result plus segmentQuality(source-sample bounds and the local
quality reports) and profile=pcm-hnr-v1. One-span output has explicit segmentIndex0
and assembly metadata; compare its numeric track/summary to standalone old JS.
Do not infer missing duration; received-sample axis, jitter:null. Await progress
hooks and yield between preparation stages/frames. Cancellation/hook/ABI errors
produce no final partial result and release only owned HNR/assembly resources.
Developer/ABI failures propagate rather than silently skipping a segment.

Freeze actual pinned JS primitive outputs and PCM before comparison. Freeze real
center/resample/YIN/quality/HNR outputs from the actual analyzePcm prefix and
actual analyzeSegments assembly (LPC/spectrogram are outside the extracted slice).
Cases include all seven quality rates, empty/DC/silence/sub-rail plateau/isolated
rails/sliding clipped intervals, source clock variation, discontinuities, clipping,
short segments and default5.25seconds at48000Hz. Native primitive equality and
actual WASM pipeline use existing exact-bit/optional-field/dB<=1e-10 rules.

Desktop verification does not establish real-device latency: resample and YIN
remain synchronous bounded calls, HNR yields between frames. Worker/WX/Android,
native-libm, LPC/formants/intensity/spectrogram/jitter and production integration
remain open. Original scientific limitations and saving/calibration policy remain.
