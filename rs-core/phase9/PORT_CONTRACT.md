# Owned YIN track sessions and cooperative host scheduling v1

Scope: independent rs-core; original mini-program path/policies stay separate.
Each session owns finite f32 signal<=262144, explicit fs/frame/hop/threshold/range.
Preserve the synchronous track admission domain: fs finite positive, finite other
numeric parameters, frame1..4096, positive hop, complete frames<=4096 and
frames*floor(frame/2)*(floor(frame/2)-1)<=150million comparison pairs. Keep this
whole-session budget, not a fresh unlimited allowance for every frame.
Finite invalid pitch ranges retain the old per-frame no-pitch result; do not change
the underlying YIN definition. Default recording options remain1024/120/0.1/40..1200.

One next call widens precisely one complete source frame to f64 and invokes the
existing yin_pitch_frame. Time is (integerStart + frameSize/2)/fs, preserving
half-sample centres for odd frames. Commit row/cursor only after calculation;
empty/short input emits no partial frame. Finish is cached/idempotent, incomplete
finish returns an error. Release owned input on finish, all buffers on cancel.
Two pitch sessions per instance, monotonic nonzero u32 handles without reuse.
Shared speech pending-result gate covers begin/next/finish/cancel before mutation.
WASM traps discard the entire instance; no replay, backend fallback or partial final.

Add pitchBegin/Next/Finish/Cancel and async trackAsync to the isolated host. Input
is copied on begin; results are copied/acknowledged before progress hooks. Await
hooks/yieldFn, check isCanceled between frames and before finish; finally cancel
only the owned session. Permit other acknowledged speech operations during yields.
Update independent analyzePcmHnr to await trackAsync, preserving its scientific
profile and final output. Expose pitch-frame progress alongside existing stage events.

Freeze actual baseline YIN tracks before native/WASM session comparison, reusing
immutable phase5 f32 inputs with their SHA identities. Include default5.25seconds,
odd frame/hop, detuned, silence transition, empty/short and legacy invalid ranges.
Require exact finite bits, optional properties, frame times and counts. Existing
PCM pipeline and all earlier numerical references remain regressions; never widen
tolerances or rewrite old references because of scheduling changes.

This yields between YIN frames, not within one YIN computation. No real-device
latency guarantee or Worker qualification. Resampling is still synchronous and is
the next scheduling batch. Native HNR sin remains oracle-qualified only.
Publish cadence from user: local validated commits each round; push every2–3 rounds.
This is round1 since last push d0620e7 and must remain local this round.
