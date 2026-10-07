# Isolated Worker analysis bridge v1

Scope: rs-core only, no production Worker/recorder integration. Protocol1 uses an
epoch plus nonreused u32 job id. Each Worker owns one WASM speech host and accepts
one job at a time. Init must complete before analysis. No automatic replay or JS
DSP fallback. Client owns PCM/boundary copies before posting; transfer only copies.
Reject shared buffers, invalid capture profiles and oversized payloads at both ends.

Worker runs the existing PCM-to-HNR entry unchanged. Progress messages contain
bounded metadata only (no f32 batches or full rows). Exactly one progress message
can await acknowledgment; await the client's async callback before acknowledging.
This bounds progress queues without dropping scientific output. Final structured
clone must preserve finite numeric values/optional fields; compare to frozen phase8
results. Validate result shape/size, source sample partition/rate and row segment
membership before resolving. One successful final only.

Cancel sets the Worker cancellation flag and releases an outstanding progress wait;
existing host finally blocks reclaim its sessions. While canceling, ignore a late
result and wait for cancellation acknowledgment before admitting a new job. Callback
failure cancels and reports the original error. Job deadline begins cancellation;
missing acknowledgment triggers termination and discards the client. Ready timeout,
Worker error/exit, malformed matching-epoch messages or fatal WASM error also discard.
Recovery is explicit new Worker/client/epoch, not rerunning the failed request.
Stale epochs/job ids/progress acknowledgments cannot alter another job. Clear all
timers and transport subscriptions on close/fault. close terminates and rejects any
active request. Empty/silent results follow the existing scientific definition.

Provide injected message transport/service and a real Node worker_threads adapter.
Verify actual Worker analysis on all8 frozen PCM/HNR cases, owned inputs, one-job
admission, async progress backpressure, cancel/hook error/restart, exit/timeout/
malformed-response cleanup and explicit recovery. Exercise portable message
callbacks via an in-memory clone transport; this is not WX runtime verification.
Keep all previous native/WASM numerical and isolation checks.

Limits: actual Node Worker verification only. Do not assume WX Worker provides
WXWebAssembly or claim WeChat/Android phone latency, clinical validity or native
libm qualification. These still need platform capability checks and real-device
evidence. A Worker may be terminated during a calculation; no partial result is
accepted. No application/calibration/history policy changes.

Batch phase10+phase11 in one local commit after verification, then push with the
already local phase9 commit: three rounds since last remote publication d0620e7.
API reference: https://nodejs.org/docs/latest-v24.x/api/worker_threads.html
