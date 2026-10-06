"""Materialize pinned JS baseline on a fresh clone, exclusively inside rs-core/_work."""
from pathlib import Path
import hashlib,io,json,subprocess,tarfile
ROOT=Path(__file__).resolve().parents[1]
COMMIT='3a0d6765147c56d2a73e1cec78f6106ae2e681ab'
destination=(ROOT/'_work/baseline').resolve()
assert destination.is_relative_to(ROOT.resolve())
repository=subprocess.run(['git','rev-parse','--show-toplevel'],cwd=ROOT.parent,check=True,capture_output=True,text=True).stdout.strip()
archive=subprocess.run(['git','archive',COMMIT],cwd=repository,check=True,capture_output=True).stdout
files=0
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for member in tar.getmembers():
        target=(destination/member.name).resolve()
        assert target.is_relative_to(destination),'Invalid archive path'
        if member.isdir():continue
        assert member.isfile(),'Only regular pinned baseline files supported'
        data=tar.extractfile(member).read()
        if target.exists():assert hashlib.sha256(target.read_bytes()).digest()==hashlib.sha256(data).digest(),str(target)
        else:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        files+=1
print(json.dumps({'status':'PASS','baselineCommit':COMMIT,'filesVerified':files}))
