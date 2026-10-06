# Speech ABI1 and frozen resampling

The `noise-wasm/speech` feature adds a stateless speech ABI to the independently built artifact. Its C exports contain both noise and speech prefixes. Attach **one host owner** per instance; do not attach separate noise and speech host objects to the same instance. A trap invalidates the entire instance.

```text
cargo build -p noise-wasm --features speech --target wasm32-unknown-unknown --release --locked --offline
```

Artifact: `target/wasm32-unknown-unknown/release/noise_wasm.wasm`. The standalone loader accepts Node WebAssembly bytes or an injected WXWebAssembly API plus package-relative path. WX return shape was simulated; real device loading and Worker scheduling are not verified. This directory is excluded from production packaging.

```javascript
const {instantiateSpeech} = require('./speech-host.cjs');
const host = await instantiateSpeech({api: WebAssembly, source: wasmBytes});
const analysisSignal = host.resample(centeredFloat32Signal, actualInputRate);
const pitch = host.track(analysisSignal, {fs:12000, frameSize:1024, hop:120,
  threshold:0.1, fmin:40, fmax:1200});
```

`centeredFloat32Signal` must already be the baseline-centered, quality-screened signal for one continuous segment. This example is a numerical call, not the full phonetic analysis pipeline: gap segmentation, clipping evidence, filter-support margins, usable duration, HNR and formants are not assembled here. YIN consumes the unwindowed, un-emphasized analysis signal; do not apply pre-emphasis before YIN.

| Host method | Input/output |
| --- | --- |
| `pitchFrame(Float64Array, options)` | Single baseline YIN result, optional fields preserved |
| `track(Float32Array, options)` | Complete-frame center times and YIN results; honors `hopSize` or `hop` |
| `preEmphasis(Int16Array, coef=.97)` | Owned Float32 PCM pre-emphasis; first sample `pcm[0]/32768` |
| `emphasizeFloat(Float32Array, coef=.97)` | Owned Float32 emphasis; first sample `signal[0]*(1-coef)` |
| `resample(Float32Array, inputRate, outputRate=12000, cutoffHz=5500)` | Owned Float32 filtered output; seven frozen profiles |

Supported input rates:12000,16000,22050,24000,32000,44100,48000. Other rates, output rates or cutoffs return status-7, without approximate fallback. Frozen129normalized257tap kernels were captured from actual baseline cache writes across262144input samples. Every output uses the baseline's ordered Float64 convolution and Float32 store.

Host pitch defaults are the application's analysis settings (12000Hz,40..1200Hz); these are not the generic legacy helper's60..500Hz defaults. Supply recorded rate and analysis settings explicitly. Unknown pitch option keys and conflicting `hop`/`hopSize` values reject rather than silently taking defaults.

ABI identity exports: `speech_abi_version`, `speech_input_capacity`, `speech_frame_capacity`. Fixed staging pointers: `speech_pcm_ptr`, `speech_signal_ptr`, `speech_frame_ptr`. Processing exports: `speech_pitch_frame`, `speech_track`, `speech_pcm_emphasis`, `speech_float_emphasis`, `speech_resample`. Result exports: `speech_result_kind` (0none,1JSON,2binaryf32), `speech_result_ptr`, `speech_result_len` (bytes), `speech_ack`.

Input capacities:262144i16/f32 or4096f64 frame samples. Track calls reject zero hop/frame, nonpositive/nonfinite sample rate, more than4096frames or more than150million centered comparison pairs. The baseline12000Hz/1024frame/120hop at5.25seconds fits this budget; the budget is a bound, not a device latency guarantee. Samples and coefficients must be finite. Single-frame finite invalid rate/range retains the baseline no-pitch result.

Statuses:0success, -2invalid argument, -3pending result, -5capacity/work budget, -7unsupported profile. There is one pending speech result. Output must be copied before acknowledgment; the host does this automatically and refreshes views after memory growth. Traps, output/memory/decode failures discard the host. No automatic replay or DSP-backend switching.

Run `python tools/run-phase3.py` for complete desktop regression, or `--repository-clean` on a fresh clone as explained in the root README. It verifies the pinned references and never regenerates them.
