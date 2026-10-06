# HNR admission fixes and continuous-segment support evidence v1

Scope: rs-core only. No recorder/page/history/calibration changes. Frozen earlier
references and numeric tolerances remain unchanged; this document supersedes only
the admission rules identified below, not previous successful results.

HNR rejects nonfinite samples before DSP/session creation, duplicate or decreasing
pitch times, hop greater than frame size, and fmax<=fmin. Zero minimum correlation
remains supported: absence of an accepted positive peak yields no-periodic-peak,
not a failed session. Admission failure must publish no result, consume no session
slot or handle, and leave an existing session usable. These are developer-facing
computation errors, not restrictions on recording or saving without calibration.

Next-stage first batch ports support evidence for one continuous segment. Inputs:
up to4096 local frame times, positive finite windowSeconds, finite margin>=0,
finite duration>=0, up to4096 finite clipping intervals within [0,duration].
Times are nonnegative, within the segment and strictly increasing; intervals have
start<end and may overlap/be unordered. Derived support endpoints must be finite.
Preserve JS operation order: time-window/2-margin and time+window/2+margin.
Output each time, support.start/end, incompleteFilterSupport (strictly outside
segment), and clipped (strict interval overlap; touching edges is not overlap).
Negative support starts are valid evidence, not invalid inputs. No rounding of
support endpoints and no implicit tolerance. This is metadata, not a new HNR
rejection/summary definition; both flags survive and policy is left explicit.

Rust computes all evidence. WASM uses owned bounded JSON and existing speech
pending/copy/ack contract; local times use existing4096-f64 staging, intervals a
separate8192-f64 staging area. No recording or calibration gates. Baseline fixtures
come from actual pinned JS addSupport/supportCrossesBoundary and analysis.js
invalidateIntervals; compare exact finite bits/fields in native and WASM.

This batch does not implement segment splitting, PCM clipping detection, offset
assembly, HNR masking/aggregation across segments, Worker execution or production
integration. Do not concatenate gaps or describe metadata primitives as a finished
phonetic pipeline. Prior real-device/native-libm/LPC limits still apply.
