"""One-time extraction of reviewed native JSON serializers; no mainline writes."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = (root/'crates/noise-core/examples/acoustics_driver.rs').read_text()
parts = ['''// Extracted from native reference driver. No DSP resides in serialization.
use noise_core::acoustics::engine::EngineSnapshot;
use noise_core::acoustics::{ProcessReceipt, SecondWindowRecord, SpectrumRecord, FilterTailResult};
''']
def section(start,end):
    return source[source.index(start):source.index(end)]
parts += [section('fn json_f64(', 'fn emit_ndjson('),section('fn json_text(', 'fn classify_f64(')]
blocks = [('emit_receipt','emit_snapshot'),('emit_snapshot','emit_second_window'),('emit_second_window','emit_spectrum'),('emit_spectrum','emit_final'),('emit_final','main')]
for name, next_name in blocks:
    text = section('fn '+name+'(', 'fn '+next_name+'(')
    text = text.replace('fn '+name+'(', 'pub(super) fn '+name.replace('emit_', 'json_')+'(',1)
    brace = text.index(' {')
    text = text[:brace]+' -> String'+text[brace:]
    text = text.replace('emit_ndjson(&line);','line')
    text = text.replace('emit_ndjson(r#"{"type":"receipt","status":"ignored_empty"}"#);','r#"{"type":"receipt","status":"ignored_empty"}"#.to_string()')
    text = text.replace('emit_ndjson(r#"{"type":"receipt","status":"ignored_after_termination"}"#);','r#"{"type":"receipt","status":"ignored_after_termination"}"#.to_string()')
    assert 'emit_ndjson' not in text
    parts.append(text)
destination = root/'crates/noise-wasm/src/acoustics_wire.rs'
assert not destination.exists(), 'One-time extraction already performed'
destination.write_text('\n'.join(parts),encoding='utf8')
