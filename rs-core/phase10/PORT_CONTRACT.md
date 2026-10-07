# Owned resampling sessions and batch scheduling v1

Independent rs-core. Reuse the phase3 frozen kernels and the same per-output-sample
arithmetic for both synchronous and session resampling. No coefficient rebuild,
new tolerance or unsupported profile fallback. Profiles remain seven source rates
to12000Hz/cutoff5500, finite f32 input<=262144, empty/short output supported.

Session owns full input and one decoded coefficient bank. Output position is always
global i*inputRate/outputRate, never reset at batch boundaries or accumulated phase.
Convolve against the full owned source and its original edge-held bounds, not a
cropped block. Preserve ordered257 taps and f32 store. Batch size1..4096, default256.
Compute an entire temporary batch before committing output/cursor; math/table
failure terminates the session, prohibits replay/final output and retains no input
or bank. Invalid batch size rejects without changing a healthy cursor.

Two resample sessions, monotonically increasing nonzero u32 handles. Shared speech
pending gate before begin/next/progress/finish/cancel. Next publishes copied f32
batch; progress publishes last start/completed/total/done. Host consumes/acks both
synchronously before invoking hooks. Finish requires complete output, is idempotent
and releases input/bank; cancel invalidates precisely its handle.

Host adds resampleBegin/Next/Finish/Cancel, resampleAsync with batchSize/yieldFn/
onProgress/isCanceled. Await hooks and yield between batches; cancellation/error
releases owned session, traps discard instance, no successful partial final.
Callback writes to copied batch data cannot change Rust's final output. Wire copy/
ack/memory-growth rules remain unchanged. Update independent PCM-to-HNR path to
await resampleAsync and report resample-batch alongside existing stage events.

Reuse all70 actual baseline phase3 vectors, compare native and actual WASM f32 bits
with different batch sizes and interleaved source-rate sessions. Check global phase,
edge support, ownership, failed-batch transaction, invalid batch, pending result,
incomplete/idempotent finish, cancel/callback failure/restart and memory growth.
Existing YIN, PCM pipeline/HNR and all prior regressions remain required.

Still no interruption within a257-tap sample, YIN frame or HNR frame, or actual
phone/Worker latency guarantee. PCM inspection/centering remain bounded synchronous
calls. No production or calibration/history policy change.

Latest user cadence: batch both local commits and pushes every2–3 rounds. Phase9
already has a local commit. Keep this phase10 round in the working tree without a
commit message/commit/push; verify a byte-preserving working snapshot instead.
