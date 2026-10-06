# Harmonicity / HNR port

This opt-in batch adds baseline normalized autocorrelation HNR and129tap fractional-delay sinc refinement, retaining eligibility, voiced evidence, coverage and minimum-duration rules. It is independent of the production app. Original recording/calibration/saving/history behavior stays on the JavaScript path.

```text
cargo build -p noise-wasm --features harmonicity --target wasm32-unknown-unknown --release --locked --offline
python tools/run-phase4.py
```

Fresh cloned SDK/line-ending settings may use `--repository-clean`, as documented in the root README. The runner includes all previous-stage regressions, never regenerates references and leaves the final artifact at `target/wasm32-unknown-unknown/release/noise_wasm.wasm`.

The HNR artifact imports exactly `env.hnr_sin(f64)->f64`. `phase3/speech-host.cjs` supplies runtime `Math.sin` and rejects all other reflected imports. This is a scalar mathematical primitive; the FFT, centering, correlation, interpolation, peak search and summary execute in Rust. Default/noise/speech-only builds retain zero imports. This explicit dependency avoids silently substituting a libm whose last-bit differences can alter Brent decisions. WX runtime primitive compatibility is not yet verified on a device.

Native verification uses a frozen trace of actual JS sine input/output pairs. The core takes an explicit sine callback; the test oracle validates arithmetic/branching, not a live native sine library. A future native backend needs its own numerical qualification.

```javascript
const {instantiateSpeech} = require('../phase3/speech-host.cjs');
const host = await instantiateSpeech({api: WebAssembly, source: harmonicityWasmBytes});
const pitch = host.track(continuousAnalysisFloat32, {fs:12000,frameSize:1024,hopSize:120});
const hnr = host.harmonicity(continuousAnalysisFloat32, {
  fs:12000,frameSize:1024,hopSize:120,fmin:40,fmax:1200,
  pitchTrack:pitch,requirePitch:true,minPeakCorrelation:0.2,maxPitchDeviation:0.15,
});
```

The example accepts one short continuous analysis segment, already centered/resampled and quality-screened. Single WASM HNR input is bounded to8192samples and512pitch rows, with at most128frames and150million fractional convolution pairs. Exceeding a bound returns capacity status-5 without publishing a partial result. Invalid configuration/evidence returns-2. Pending results return-3. Do not split/recombine an entire recording using this example: global times, filter support, nearest-pitch state, gaps and valid-duration assembly need a separately verified streaming/Worker adapter.

`speech_pitch_ptr` exposes owned Float64 evidence staging triples(time,f0,aperiodicity); `speech_pitch_capacity` returns512, `speech_hnr_input_capacity` returns8192. `speech_harmonicity` produces JSON in the existing speech result slot. The host copies, decodes, then acknowledges; an imported math exception or WASM trap discards the instance. `hopSize`/`hop` aliases agree or reject; unknown options reject.

Returned `db:null` is not a zero-dB estimate. Low-energy, unvoiced/uncertain and gap-boundary rows do not count as eligible; other failures reduce coverage. `partialMeanHNR` remains inspectable when `avgHNR` is withheld by coverage<0.5 or valid duration<0.1seconds. HNR is a periodicity estimate; independent pitch-free estimates are permitted by baseline default, while the app pipeline uses `requirePitch:true`. Do not label it as a diagnostic classifier.

References:44baseline result/summary/refinement cases plus6observed intermediate-state cases; native peak/lag/counters/optional fields match exact bits, dB allows the existing1e-10budget. WASM compares25HNR track cases using live runtime Math.sin. No real WX/Worker/Android recording, full5second scheduling, native libm, LPC/formants or clinical validity gate is claimed.
