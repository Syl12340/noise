"""Record pre-comparison profile and unchanged-production identities."""
from pathlib import Path
import json, hashlib, subprocess
root=Path(__file__).resolve().parents[1]
project=root.parent
out=root/'phase1/NUMERIC_PROFILE_V1.json'
assert not out.exists(), 'Already frozen; do not overwrite'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
baseline=json.loads((root/'phase0/BASELINE_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
tracked=subprocess.run(['git','ls-files'],cwd=project,capture_output=True,text=True,encoding='utf-8',check=True).stdout.splitlines()
production={name:sha(project/name) for name in tracked if not name.startswith('rs-core/') and (project/name).is_file()}
profile={'profile':'legacy-noise-44100-native-v1','frozenBeforeRustComparison':True,
 'date':'2026-10-06','baselineCommit':baseline['baselineCommit'],
 'contractSha256':sha(root/'phase1/PORT_CONTRACT.md'),
 'tablesManifestSha256':sha(root/'coefficients/noise-44100-v1/manifest.json'),
 'acceptance':{'linearAlgebra':'bit-exact','countsQualityWindowTail':'exact',
 'finiteDbAbsolute':1e-10,'rmsAbsoluteFactorEpsilon':32,'epsilon':2**-52,
 'nonFinite':'class-equivalent, not JSON-null'},
 'scientificStatus':'Engineering compatibility only; no full-domain libm proof or device verification',
 'productionWorkingFileHashes':production}
out.write_text(json.dumps(profile,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'profile':profile['profile'],'productionFiles':len(production),'contractSha256':profile['contractSha256']},ensure_ascii=False))
