"""One-time trim of non-frozen source EOF only. Does not change fixture bytes."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
for name in ('Cargo.toml','rust-toolchain.toml','crates/noise-wasm/src/acoustics_wire.rs'):
    p=ROOT/name;data=p.read_bytes();newline=b'\r\n' if b'\r\n' in data else b'\n'
    p.write_bytes(data.rstrip(b'\r\n')+newline)
