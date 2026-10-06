"""Remove ambiguous probe protocol autodetection; add actual RMS scalar call."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
target=root/'crates/noise-core/examples/acoustics_driver.rs'
text=target.read_text(encoding='utf-8')
start=text.index('                // Optional length prefix')
end=text.index('                if cursor + sample_count * 8',start)
text=text[:start]+'                let sample_count = 32768usize;\n'+text[end:]
start=text.index('                let sub_op_id: u8;')
end=text.index('                let result = match sub_op_id',start)
replacement='''                let sub_op_id = data[cursor];
                cursor += 1;
                let op_name = match sub_op_id {
                    1 => "sqrt", 2 => "log10", 3 => "pow10", 4 => "db",
                    5 => "leq", 6 => "time_term", 7 => "classify", 8 => "cne", 9 => "rms",
                    _ => "unknown",
                };

'''
text=text[:start]+replacement+text[end:]
start=text.index('                let result = match sub_op_id')
end=text.index('                    _ => {',start)
replacement='''                    9 => {
                        if cursor + 4 > data.len() { emit_ndjson(r#"{"type":"error","code":"rms_header_eof"}"#); process::exit(1); }
                        let count = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap()) as usize;
                        cursor += 4;
                        if count > MAX_CHUNK_SAMPLES || cursor + count * 8 > data.len() {
                            emit_ndjson(r#"{"type":"error","code":"invalid_rms_length"}"#); process::exit(1);
                        }
                        let mut values = Vec::with_capacity(count);
                        for _ in 0..count {
                            values.push(f64::from_le_bytes(data[cursor..cursor + 8].try_into().unwrap()) as f32);
                            cursor += 8;
                        }
                        noise_core::acoustics::calculate_rms(&values)
                    }
'''
text=text[:end]+replacement+text[end:]
target.write_text(text,encoding='utf-8')
print('Driver: opcode6 fixed 32768*f64, opcode7 fixed sub-op u8, opcode9 actual RMS')
