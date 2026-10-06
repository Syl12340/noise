"""Frozen HNR references refuse overwrite and retain every byte."""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parents[1]
files=[p for folder in ('phase4/reference','phase4/states','coefficients/hnr-v1') for p in (root/folder).glob('*') if p.is_file()]
before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
for command in ('export_hnr_reference.cjs','export_hnr_states.cjs'):
    run=subprocess.run(['node','tools/'+command],cwd=root,capture_output=True,text=True)
    assert run.returncode!=0 and 'already frozen' in run.stderr
assert before=={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in before}
print(json.dumps({'status':'PASS','frozenFilesUnchanged':len(before),'exportersRefusedOverwrite':True}))
