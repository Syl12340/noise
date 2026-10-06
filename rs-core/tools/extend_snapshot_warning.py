from pathlib import Path
root=Path(__file__).resolve().parents[1]
target=root/'crates/noise-core/examples/acoustics_driver.rs'
text=target.read_text(encoding='utf-8')
old='"type":"snapshot","seq":{},"state":"{}","total_a_samples":{}'
new='"type":"snapshot","seq":{},"state":"{}","near_full_scale_observed":{},"total_a_samples":{}'
assert text.count(old)==1
text=text.replace(old,new).replace('json_text(&s.state).trim_matches(\'"\'),','json_text(&s.state).trim_matches(\'"\'),\n        s.near_full_scale_observed,')
target.write_text(text,encoding='utf-8')
