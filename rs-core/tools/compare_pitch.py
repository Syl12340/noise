"""Frozen actual-JS vs native Rust pitch, exact values and optional fields."""
import hashlib
import json
import pathlib
import struct
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
REF = ROOT / 'phase2/pitch-reference'
EXPECTED_SHA = '046930004d0524718f76f383271b8d006d85b42b3d224104f39b21f4fe3c9383'
data = (REF / 'manifest.json').read_bytes()
assert hashlib.sha256(data).hexdigest() == EXPECTED_SHA, 'Frozen pitch profile altered'
manifest = json.loads(data)
EDGE_SHA = '5ddbeb6fcd9676b844f9220e67de5dd3c9467b2b12a63a0f55f3f10cef5e581e'
edge_data = (REF / 'edge-manifest.json').read_bytes()
assert hashlib.sha256(edge_data).hexdigest() == EDGE_SHA, 'Frozen edge profile altered'
edge_manifest = json.loads(edge_data)
assert edge_manifest['sources'] == manifest['sources']
for src in manifest['sources']:
    assert hashlib.sha256((ROOT / '_work/baseline' / src['path']).read_bytes()).hexdigest() == src['sha256']
driver = ROOT / 'target/release/examples/speech_driver.exe'
stats = {'cases':0, 'f64_bits':0, 'f32_bits':0, 'fields':0}
failures = []

def compare(actual, expected, label, float32=False):
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), (label,'optional fields',actual,expected)
        for k,v in expected.items(): compare(actual[k],v,label+'.'+k,float32)
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), (label,'length')
        for i,(a,e) in enumerate(zip(actual,expected)): compare(a,e,f'{label}[{i}]',float32)
    elif isinstance(expected, (float,int)) and not isinstance(expected,bool):
        fmt = '<f' if float32 else '<d'
        assert struct.pack(fmt,actual) == struct.pack(fmt,expected), (label,actual,expected)
        stats['f32_bits' if float32 else 'f64_bits'] += 1
    else:
        assert actual == expected, (label,actual,expected)
        stats['fields'] += 1

for case in manifest['cases'] + edge_manifest['cases']:
    payload = REF / case['input']
    assert hashlib.sha256(payload.read_bytes()).hexdigest() == case['sha256']
    cfg = case['config']
    argv = [str(driver),case['op'],str(payload)]
    if case['op'] in ('frame','track'):
        argv += [str(cfg[k]) for k in ('fs','threshold','fmin','fmax')]
        if case['op']=='track': argv += [str(cfg['frameSize']),str(cfg['hop'])]
    else: argv += [str(cfg['coef'])]
    try:
        output = subprocess.run(argv,check=True,capture_output=True,text=True)
        compare(json.loads(output.stdout),case['expected'],case['name'],case['op'] in ('pcm','float'))
        stats['cases'] += 1
    except (AssertionError,subprocess.CalledProcessError) as error:
        failures.append({'case':case['name'],'error':str(error)})
report = {'status':'PASS' if not failures else 'FAIL','profile':manifest['profile'], 'reference_manifest_sha256':EXPECTED_SHA,'edge_manifest_sha256':EDGE_SHA,'driver_sha256':hashlib.sha256(driver.read_bytes()).hexdigest(),'stats':stats,'failures':failures}
(ROOT / 'reports/pitch-compatibility.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,indent=2))
raise SystemExit(1 if failures else 0)
