"""Verify exact scoped staged bytes before publication; no mutations."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT.parent
def git(*args):return subprocess.run(['git',*args],cwd=PROJECT,check=True,capture_output=True).stdout
names=git('diff','--cached','--name-only','-z').decode('utf8').split('\0')
names=[n for n in names if n]
assert names and all(n.startswith('rs-core/') or n=='project.config.json' for n in names),names
assert all('/target/' not in n and '/_work/' not in n and '__pycache__' not in n for n in names)
identities=git('ls-files','--stage','-z','--','rs-core').decode('utf8').split('\0')
assert git('rev-parse','--show-object-format').strip()==b'sha1'
count=0
for row in identities:
    if not row:continue
    meta,name=row.split('\t',1);mode,digest,stage=meta.split(' ')
    assert stage=='0' and mode=='100644',(name,mode,stage)
    data=(PROJECT/name).read_bytes()
    assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==digest,(name,'Staged bytes differ')
    count+=1
pack=git('show',':project.config.json');previous=git('show','HEAD:project.config.json')
line=b'      { "type": "folder", "value": "rs-core" },\n'
assert pack.count(line)==1 and pack.replace(line,b'',1)==previous,'Unexpected public configuration edits'
print(json.dumps({'status':'PASS','stagedFiles':len(names),'rsCoreBytesVerified':count,'productionEdit':'Only rs-core package exclusion','unrelatedFilesExcluded':True}))
