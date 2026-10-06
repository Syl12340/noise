"""An existing reference package cannot be silently overwritten by its exporter."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[1]
files=list((ROOT/'phase3/resample-reference').glob('*'))+list((ROOT/'coefficients/speech-resample-12000-v1').glob('*'))
before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}
run=subprocess.run(['node','tools/export_resample_reference.cjs'],cwd=ROOT,capture_output=True,text=True)
assert run.returncode!=0 and 'already frozen; refusing to overwrite' in run.stderr
assert before=={name:hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in before}
print(json.dumps({'status':'PASS','frozenFilesUnchanged':len(before),'exporterRefusedOverwrite':True}))
