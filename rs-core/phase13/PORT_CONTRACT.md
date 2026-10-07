# Full speech assembly, LPC/formants and spectrogram v1

Scope: rs-core only. Preserve pinned3a0d6765 scientific definitions, including
experimental/unvalidated formant status and known baseline failures. Complete the
requested standard full PCM result with pitch, intensity, HNR, formant tracking,
spectrogram, quality/support, coverage and received-sample segment assembly.
Original mini-program/history/calibration/saving remain separate.

Freeze actual Burg/root/frame/tracking/STFT and full-analysis results before
comparison. Burg ordered f64 must match. Durand-Kerner seeds and Hamming/Hann
windows come from captured JS coefficients, not runtime trig regeneration.
Root solver uses explicit hypot/atan2/log callbacks; spectrogram log10 uses the
same runtime primitive. Full-speech WASM adds fixed env scalar math imports; old
speech/harmonicity builds retain their existing import sets. Native comparison
uses recorded JS math oracles and does not qualify a live native libm.

Formant resampling follows source's maxFormant-dependent rate/cutoff profiles,
with exact257-tap kernels captured over the maximum input phase domain. Preserve
candidate ordering, bandwidth holes, cross-order alignment/numbering, monotonic
tracking/reacquisition, quality/exploratory evidence and numerical-failure rows.
Do not promote cross-model agreement to quantitative accuracy.

Spectrogram follows actual short Hann window, zero padding, frozen radix2 FFT,
coherent-gain convention, dB floor/clipping and f32 normalized stores. Keep actual
STFT times/frequency-bin count; never stretch columns to recording edges. Large
spectral arrays are copied through bounded binary columns, separate from JSON
metadata. Hold complete segment inputs to avoid cross-gap DSP contamination.

Full result assembly preserves source clocks/support shifts, clipping then gap
reason priority, all-row HNR summary and null cross-gap perturbation value. Digital
intensity remains dBFS with normalized referenceRms1; frame-period variability
is not pulse jitter. Use a new explicit pcm-speech-v2 profile; PCM-HNR v1 unchanged.

Frames/order/output quotas and developer configuration failures are explicit.
Cooperative session steps and trap/cancel cleanup prohibit successful partial
final results; numerical formant failures stay local as in JS. No backend DSP
fallback. Test nominal5.25s domain and boundary/empty-short shapes. This standard
profile excludes optional model-sensitivity and the original selection-offset
adapter; passing a PCM slice creates a new zero-based analysis, not an absolute
selection result. A developer/session failure aborts the full transaction rather
than silently returning the original JS multi-segment partial-success policy.

Review baseline compatibility and scientific validity separately. Clinical,
WX/Android/iOS runtime, native libm and package/performance qualification are
still separate gates; report measured artifact/data sizes. Current batch contains
phase12 and this requested combined work; commit/push only after all required checks.
