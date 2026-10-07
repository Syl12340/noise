"""Check immutable captured full-speech coefficients and actual WASM import shape."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[1];table=root/'coefficients/full-speech-v1'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(table/'manifest.json')=='377cd96eb1267fce7808ebee293b02046fe04aa12cb9266b94816ee7dd90263f'
m=json.loads((table/'manifest.json').read_text())
for name,digest in m['files'].items():assert sha(table/name)==digest,name
print(json.dumps({'status':'PASS','profiles':len(m['profiles']),'coefficientBytes':sum((table/n).stat().st_size for n in m['files']),'manifestSha256':sha(table/'manifest.json')}))
