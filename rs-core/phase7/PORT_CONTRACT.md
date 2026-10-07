# Segment planning, pitch qualification and completed HNR assembly v1

Isolated rs-core. Source sample domain <=262144, rates
12000/16000/22050/24000/32000/44100/48000; analysis rate12000.
No recording/calibration/save/history policy. No unknown missing duration inference.

planSegments mirrors the actual analyzePcm cut normalization: ignore nonfinite,
nonpositive and >=received-duration boundaries, Math.round(time*sourceRate),
exclude endpoints, deduplicate, numeric sort; emit adjacent source-sample spans.
Up to4096 boundary inputs, at most128 resulting segments. Capture continuity is
reset before DSP, so callers use each span for independent centering/resampling/YIN.

preparePitchEvidence accepts a local time/f0/aperiodicity track (<=4096 rows),
source sample count/rate, frame size and local clipping intervals (<=4096).
Use actual support time +/- frameSize/12000/2 +/-128/sourceRate in baseline
operation order. Outside support first clears f0 with incomplete-filter-support,
then strict clipping overlap clears f0 and overrides reason with clipped-input.
Other YIN optional diagnostic fields are not part of this evidence-only result.

HNR assembly owns copied completed results: receives contiguous source spans covering all
received samples and completed HNR handles, or explicit failed spans. At most128
segments,4096 total HNR rows,4096 total clipping intervals. Completed handles
must have matching rate/frame/hop and input length=floor(spanSamples*12000/rate),
with requirePitch=true, fmin40/fmax1200, minPeakCorrelation0.2, deviation0.15
(the current recording pipeline profile; different scientific profiles reject),
and a cached finish result. Append copies results; the caller can then cancel its
HNR handle, allowing more than two sequential segments. One assembly per instance,
monotonic nonreused handles; incomplete finish rejects, finish is idempotent,
cancel releases only its assembly. No replay or automatic segment finish.
Validate before each append; pending result blocks operations before mutation.

Attach support and invalidate clipping in local coordinates. Then add source
startSample/sourceRate to time and support endpoints in the exact JS order.
For multiple spans, global support outside that span clears db and overrides reason
with capture-gap-boundary, including the floating-point endpoint comparison.
Retain peak metadata and original signalFrames/cappedFrames as the baseline does.
Do not average segment means: summarize all ordered masked rows once with hop/12000.
Failed spans have no quantitative rows and enter invalidIntervals with their
received-sample extent and explicit failure status. All failed => explicit error.
Output analysisSegments, invalidIntervals, harmonicity, avgHNR, jitter:null,
timeAxis:received-samples and discontinuityPolicy:segment-before-dsp.

Freeze actual baseline functions before comparisons; source extraction happens
only in the one-time exporter. Fixtures include cut rounding/deduplication, filtered
pitch evidence, clipping/contact, segment edges, noninteger source clocks and
failed/empty-row segments. Compare exact finite numbers/fields and inherited
dB<=1e-10. Separate integration checks compute real WASM HNR from independent
segments, use prepared evidence and compare the assembled result to old JS.

This is the HNR metadata/assembly layer. It does not inspect raw PCM clipping,
run an entire recording pipeline, infer missing samples, compute jitter across
gaps, migrate LPC/formants or qualify Worker/WX/Android runtime performance.
