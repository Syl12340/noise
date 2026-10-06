from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parents[1];files=[p for p in (root/'phase5/reference').glob('*') if p.is_file()]
before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
run=subprocess.run(['node','tools/export_hnr_full_reference.cjs'],cwd=root,capture_output=True,text=True)
assert run.returncode!=0 and 'already frozen' in run.stderr
assert before=={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in before}
print(json.dumps({'status':'PASS','frozenFilesUnchanged':len(before)}))
