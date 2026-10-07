# Digital intensity and frame-period variability v1

Independent rs-core, standalone metrics only; existing PCM-HNR/Worker v1 output
and original mini-program policies remain unchanged. No physical SPL conversion,
calibration offset or clinical jitter interpretation.

Intensity accepts finite normalized f32 data<=262144 samples, finite positive fs,
frame1..4096, positive hop<=u32::MAX, complete frames<=4096. Missing frame/hop default to
actual baseline Math.round(fs*.025)/Math.round(fs*.01), resolved in Rust with
JS rounding. Reject zero/overflowed defaults and nonfinite derived frame times.
Reuse exact source order: sum s*s, sqrt(sum/frame), max(rms,1e-12),20*log10.
Time=(integer start+frame/2)/fs; no window weighting/pre-emphasis or overlap-energy
correction. Empty/short data has no partial frame. Report unit=dBFS, rectangular
RMS and calibrationApplied=false; do not force db<=0 because centered normalized
input can exceed full scale. Explicit clipping/segment support policies are not
part of this primitive and remain a later assembly layer.

Pitch-period variability accepts <=4096 finite f64 F0 values in caller-supplied
frame order. Positive F0 yields period1/f0; nonpositive F0 resets adjacency. Preserve
ordered abs(period-previous), pair mean(period+previous)/2 and ratio sumDiff/sumMean.
No pair => null; detect nonfinite reciprocal/reductions instead of publishing NaN
or an overflow-derived zero. Metadata unit=ratio, cycleJitter=false. This is the
baseline descriptive frame-level statistic, never cycle-to-cycle glottal jitter.
Optional hasCaptureGaps/clippedInput flags give null with an explicit reason,
matching existing record-wide suppression; neither flag changes recording/saving.
No timestamps are interpolated and no missing-duration/voiced-gap bridge is inferred.

WASM uses speech result/pending/copy/ack gates. Intensity stages existing f32 input;
variability stages existing4096-f64 frame input. Validate parameters/capacity before
DSP/publishing; invalid requests leave result/other sessions untouched. No partial
statistics. Freeze actual pinned voice-metrics.js output before implementation.
Intensity db inherits1e-10 absolute budget, exact time/frame/metadata; variability
is exact f64 bits/null. Include seven rates, silent/DC/alternating/impulse/default
5.25s/odd grids, positive db, pause resets/no-pair/period ratio cases. All existing
PCM-HNR, Worker and core regressions remain required.

No current pipeline/Worker schema expansion. Native libm/device/clinical qualification
is separate. This is new batch round1 after6953470; no staging, commit or push.
