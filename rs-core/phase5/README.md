# Complete continuous HNR sessions

This batch schedules the existing HNR algorithm over an owned complete continuous analysis signal, one complete frame per step. It is independent of the original app; calibration, saving and historical records are unaffected.

```javascript
const {instantiateSpeech}=require('../phase3/speech-host.cjs');
const host=await instantiateSpeech({api:WebAssembly,source:harmonicityWasmBytes});
const result=await host.harmonicityFull(continuousCenteredAnalysisSignal,{
  fs:12000,frameSize:1024,hopSize:120,fmin:40,fmax:1200,
  pitchTrack:existingQualifiedPitchEvidence,requirePitch:true,
},{
  onProgress:receipt=>showProgress(receipt.completed,receipt.total),
  isCanceled:()=>cancellationRequested,
  yieldFn:()=>new Promise(resolve=>setTimeout(resolve,0)),
});
```

The frame grid, global time, forward nearest-pitch cursor and final summary stay in Rust. Final means use all ordered valid rows, not averages of batch averages. Float32 signal and pitch rows are copied at session admission; later staging writes or changes to the caller's array cannot alter the admitted signal. Single-frame/short-HNR methods remain unchanged.

Limits:262144signal samples,4096pitch rows,4096complete frames, two live sessions. Default5.25seconds at12kHz produces517rows and fits. Each frame has the existing150million fractional-pair budget; an error marks the session failed and prohibits final completion or automatic replay. Paused/progress data never masquerades as a complete result. A frame can still be slow: yielding only occurs between frames; Worker/device latency is not yet qualified.

Low-level methods: `hnrBegin`, `hnrNext`, `hnrFinish`, `hnrCancel`. New exports: `speech_hnr_session_abi_version`(1), `speech_session_pitch_capacity`(4096), `speech_session_pitch_ptr`, `speech_hnr_begin/next/finish/cancel`. Old short-HNR pitch capacity512 and signal limit8192 remain intact. Frame receipts contain `index`, `completed`, `total`, `done` and `row`; a complete receipt is idempotent. Premature finish returns-8, stale handle-1, two-session limit-6, pending result-3, capacity-5, invalid input-2.

`harmonicityFull` copies/acknowledges each receipt before awaiting progress/yield hooks. Async callback rejection, cancellation or yielding errors release only that session; a WASM/math trap discards the whole instance. Cancellation is checked between steps and after awaited hooks; it cannot interrupt a running frame or a hook that never settles. Raw consumers must follow the shared speech result acknowledgment rule. Do not attach separate independent owners to one instance.

This method requires a **continuous, already centered/resampled and quality-qualified analysis segment**. Do not concatenate capture gaps; clipping exclusions, filter-support margins, segment offsets and full phonetic pipeline assembly are not handled here. Evidence times must use this segment's time origin. Native validation still uses actual-JS scalar sine traces; real native libm and WX/Android remain unqualified.

Run from `rs-core`:

```text
python tools/run-phase5.py
```

Fresh clones may use `--repository-clean` as described in the root README. The runner includes all previous stages and never overwrites frozen references. It builds the `harmonicity` feature and verifies whole vs scheduled output on identical actual-JS input, plus interleaving, ownership, pending gate, cancellation and failure lifecycle checks.
