"""One-time publication profile: only line endings differ from frozen working bytes."""
from pathlib import Path
import hashlib,json
ROOT=Path(__file__).resolve().parents[1]
old=json.loads((ROOT/'phase1/NUMERIC_PROFILE_V1.json').read_text(encoding='utf8'))
files={}
for name,digest in old['productionWorkingFileHashes'].items():
    data=(ROOT.parent/name).read_bytes()
    assert hashlib.sha256(data).hexdigest()==digest,name
    try:data.decode('utf8');text=b'\x00' not in data
    except UnicodeDecodeError:text=False
    canonical=data.replace(b'\r\n',b'\n') if text else data
    files[name]={'mode':'utf8-line-endings' if text else 'binary','sha256':hashlib.sha256(canonical).hexdigest()}
profile={'rule':'Only UTF8 CRLF/LF form may differ from the original frozen working files; all other bytes unchanged. Binary files exact.',
         'sourceProfileSha256':hashlib.sha256((ROOT/'phase1/NUMERIC_PROFILE_V1.json').read_bytes()).hexdigest(),'files':files}
destination=ROOT/'phase3/REPOSITORY_CONTENT_PROFILE.json'
assert not destination.exists(),'Already frozen'
raw=(json.dumps(profile,indent=2,sort_keys=True)+'\n').encode('utf8')
destination.write_bytes(raw)
print(json.dumps({'files':len(files),'sha256':hashlib.sha256(raw).hexdigest()}))
