"""Verify the frozen pre-port working tree and immutable reference identities."""
from pathlib import Path
import hashlib, json, subprocess, sys
root=Path(__file__).resolve().parents[1]
project=root.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
profile=json.loads((root/'phase1/NUMERIC_PROFILE_V1.json').read_text(encoding='utf-8'))
changed=[name for name,digest in profile['productionWorkingFileHashes'].items()
         if not (project/name).is_file() or sha(project/name)!=digest]
sdk_from_baseline=False
line_ending_only=[]
if '--repository-clean' in sys.argv:
    canonical_path=root/'phase3/REPOSITORY_CONTENT_PROFILE.json'
    assert sha(canonical_path)=='ff88cd8e07156501d944ba0d9352cce20961e4246a7760cfbd8d6a8dcd0006b9'
    canonical_profile=json.loads(canonical_path.read_text(encoding='utf8'))
    assert canonical_profile['sourceProfileSha256']==sha(root/'phase1/NUMERIC_PROFILE_V1.json')
    assert canonical_profile['files'].keys()==profile['productionWorkingFileHashes'].keys()
    for name in changed[:]:
        if not (project/name).is_file():continue
        data=(project/name).read_bytes()
        entry=canonical_profile['files'][name]
        lf=data.replace(b'\r\n',b'\n') if entry['mode']=='utf8-line-endings' else data
        if entry['sha256']==hashlib.sha256(lf).hexdigest():
            changed.remove(name);line_ending_only.append(name)
if '--repository-clean' in sys.argv and 'project.private.config.json' in changed:
    name='project.private.config.json'
    baseline=subprocess.run(['git','show','3a0d6765147c56d2a73e1cec78f6106ae2e681ab:'+name],cwd=project,check=True,capture_output=True).stdout
    committed=subprocess.run(['git','show','HEAD:'+name],cwd=project,check=True,capture_output=True).stdout
    normalize=lambda value:value.replace(b'\r\n',b'\n')
    if normalize((project/name).read_bytes())==normalize(baseline)==normalize(committed):
        changed.remove(name);sdk_from_baseline=True
assert not changed, changed
assert sha(root/'phase1/PORT_CONTRACT.md')==profile['contractSha256']
table=root/'coefficients/noise-44100-v1'
assert sha(table/'manifest.json')==profile['tablesManifestSha256']
manifest=json.loads((table/'manifest.json').read_text(encoding='utf-8'))
for name,identity in manifest['files'].items():
    assert sha(table/name)==identity['sha256'], name
audit=json.loads((root/'reports/fixture-independent-audit.json').read_text(encoding='utf-8'))
for name,digest in audit['payloadHashes'].items():
    assert sha(root/'phase0/fixtures'/name)==digest, name
print(json.dumps({'status':'PASS','productionWorkingFilesUnchanged':len(profile['productionWorkingFileHashes'])-int(sdk_from_baseline),
                 'repositorySDKConfigurationFromBaseline':sdk_from_baseline,'lineEndingOnlyMatches':line_ending_only,
                 'frozenP0PayloadsUnchanged':len(audit['payloadHashes']),'tablePackageUnchanged':True,
                 'comparisonProfileFrozen':profile['profile']},ensure_ascii=False))
