"""Full session vs actual baseline reference; never regenerates math traces."""
from pathlib import Path
import hashlib,json,struct,subprocess,tempfile
import compare_hnr as shared
root=Path(__file__).resolve().parents[1];ref=root/'phase5/reference'
SHA='39bb05fd1bdfa30b420fa9f45123ac0417163e8c2145759dcfdbdd991a46a3c1'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(ref/'manifest.json')==SHA
manifest=json.loads((ref/'manifest.json').read_text(encoding='utf8'))
driver=root/'target/release/examples/harmonicity_driver.exe';work=Path(tempfile.mkdtemp(prefix='hnr-full-',dir=root/'_work'))
for c in manifest['cases']:
    assert sha(ref/c['input'])==c['inputSha256'];assert sha(ref/c['oracle'])==c['oracleSha256']
    cfg=c['config'];data=(ref/c['input']).read_bytes();oracle=(ref/c['oracle']).read_bytes();pitch=cfg['pitchTrack']
    payload=b'HNC1\x06'+struct.pack('<dIIddBddII',cfg['fs'],cfg['frameSize'],cfg['hopSize'],cfg['fmin'],cfg['fmax'],cfg['requirePitch'],cfg['minPeakCorrelation'],cfg['maxPitchDeviation'],len(data)//4,len(pitch))+data
    payload+=b''.join(struct.pack('<ddd',p['time'],p['f0'],p['aperiodicity'])for p in pitch)+struct.pack('<I',len(oracle)//16)+oracle
    file=work/(c['name']+'.hnc1');file.write_bytes(payload)
    run=subprocess.run([str(driver),str(file)],capture_output=True,text=True,timeout=60);assert run.returncode==0,(c['name'],run.stderr)
    shared.compare(json.loads(run.stdout,parse_int=float),c['expected'],c['name']);shared.stats['cases']+=1
report={'status':'PASS','stats':shared.stats,'manifestSha256':SHA,'driverSha256':sha(driver),'mathDependency':'Frozen actual-JS scalar sin oracle, not live native libm qualification.'}
(root/'reports/hnr-full-native.json').write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'));print(json.dumps(report,indent=2))
