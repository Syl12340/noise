# Harmonicity migration v1

Independent rs-core, no production integration or changes to scientific definitions, calibration/saving/history policy. This batch ports baseline harmonicity.js, fractional-correlation.js and calculateHNR only; HNR is a periodicity estimate, not a diagnostic classifier.

## Arithmetic and math dependencies

Use the actual unwindowed centered-frame mean/prefix energy order, twice-forward radix2 FFT autocorrelation and overlap-normalized integer correlation. General FFT sizes512..8192 use prefixes of the already frozen15stage rotations. Freeze the actual129sample fractional Blackman window from baseline code. Do not substitute parabolic-height interpolation for normalized fractional-delay dot products.

Dynamic sinc Math.sin cannot be replaced with a different native math library without qualification: one-ULP changes may alter Brent's comparisons and peak selection. The wasm harmonicity feature imports exactly one scalar function `env.hnr_sin(f64)->f64`; the host supplies its runtime Math.sin. All DSP, interpolation, search and aggregation remain Rust. Existing default/noise/speech-only builds retain zero imports. No arbitrary imports, no JS DSP fallback.

Native validation injects a frozen oracle of actual JS sin(input)->output calls, keyed by exact f64 input bits. Unknown inputs fail the validation rather than silently using another libm. This validates the Rust arithmetic path using the same mathematical primitive; it does not qualify a live native libm backend. Native core takes an explicit sin callback. Freeze all inputs and sin traces BEFORE comparing Rust outputs.

Require exact finite bits for means/prefix energies, integer/raw correlation, peak correlation and lag; exact optional fields, reasons, frame times/counts, eligibility, coverage, convergence and refinement evaluation counts. HNR dB and ordered average/partial mean allow absolute1e-10dB, inherited from phase1 math budget; no post-hoc widening. Nonfinite classes explicit; JS null remains null. calculateHNR rejects nonfinite/out-of-domain correlations and applies only the upper clamp1-1e-6. Summary excludes low-energy/unvoiced-or-uncertain/capture-gap-boundary only, requires coverage>=0.5 and duration+1e-9>=minimum.

## Bounded prototype API

Native HNR accepts finite Float32 signals, positive finite fs, frame256..4096, positive hop, positive range with fmax>=fmin and fmax<=fs/2; pitch evidence finite and chronological. Whole-core input max262144. Single WASM HNR input max8192, pitch evidence max512rows(time,f0,aperiodicity), frame count max128. Call-level fractional convolution pair budget150million, shared across all candidates/frames; each evaluation charges count for integer shifts or count*129 for sinc convolution before executing. Exceeding budget returns explicit capacity failure without publishing a partial result. No automatic splitting/merging across gaps or replay.

One pending speech result, standard copy/decode/ack, same trap lifecycle. Signal staging and dedicated pitch-evidence staging owned by WASM. HNR options honor hopSize/hop and reject unknown/conflicting options. Summarize may be exposed as native first; WASM summary comes with each HNR track. Track inputs/outputs and boundary status are preserved. Imported Math.sin must be a pure trusted primitive, not a callback into the module; reentry traps. One host owns an instance.

## Acceptance and limits

Actual-JS fixtures exercise fractional/integer/detuned/harmonic/noisy/DC/silent/short signals, absent/uncertain/stale pitch, narrow ranges, and independent summary boundary rules. Native and real WASM use identical frozen references. Re-run existing 26noise/49pitch/70resample and default probe checks. WX loader shape is simulation, not device validation. Full5s HNR scheduling/Worker/session assembly, LPC/formants, native libm qualification and scientific/clinical validity remain open. Publication is appropriate only after scoped staging and full regression.
