"""Strict actual-JS HNR comparison with an explicit frozen scalar math oracle."""
from pathlib import Path
import hashlib,json,math,struct,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1]
REF=ROOT/'phase4/reference'
MANIFEST_SHA='57f98723dab3807de382e06cfe715d378b114a57629fb30adf7de260e51c6263'
WINDOW_SHA='fd11f285791e45ad7f14e60373e4b99cf9a1c6e9aba62dd9612c1f0d6a4df888'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def number(v):
    if isinstance(v,str) and v in ('NaN','+Infinity','-Infinity','-0'):return {'NaN':math.nan,'+Infinity':math.inf,'-Infinity':-math.inf,'-0':-0.0}[v]
    return v
def verify():
    assert sha(REF/'manifest.json')==MANIFEST_SHA
    assert sha(ROOT/'coefficients/hnr-v1/fractional-window.f64le')==WINDOW_SHA
    manifest=json.loads((REF/'manifest.json').read_text(encoding='utf8'))
    for src in manifest['sources']:assert sha(ROOT/'_work/baseline'/src['path'])==src['sha256']
    for c in manifest['cases']:
        assert sha(REF/c['input'])==c['inputSha256']
        assert sha(REF/c['oracle'])==c['oracleSha256']
    return manifest
def protocol(c):
    cfg=c['config'];inp=(REF/c['input']).read_bytes();oracle=(REF/c['oracle']).read_bytes()
    if c['op']=='hnr':
        pitch=cfg['pitchTrack'];data=b'\x01'+struct.pack('<dIIddBddII',cfg['fs'],cfg['frameSize'],cfg['hopSize'],cfg['fmin'],cfg['fmax'],cfg['requirePitch'],cfg['minPeakCorrelation'],cfg['maxPitchDeviation'],len(inp)//4,len(pitch))+inp
        data+=b''.join(struct.pack('<ddd',p['time'],p['f0'],p['aperiodicity']) for p in pitch)
    elif c['op']=='fractional':data=b'\x02'+struct.pack('<dddI',cfg['initial'],cfg['lower'],cfg['upper'],len(inp)//8)+inp
    elif c['op']=='scalar':data=b'\x03'+struct.pack('<d',number(cfg['correlation']))
    else:
        data=b'\x04'+struct.pack('<ddI',cfg['hop'],cfg['min'],len(cfg['track']))
        reasons={None:0,'low-energy':1,'unvoiced-or-uncertain':2,'capture-gap-boundary':3,'low-periodicity':4,'no-periodic-peak':5}
        for row in cfg['track']:data+=struct.pack('<dBdB',row.get('time',0),int(row['db'] is not None),number(row['db']) if row['db'] is not None else 0,reasons.get(row.get('reason'),6))
    if c['op'] in ('hnr','fractional'):data+=struct.pack('<I',len(oracle)//16)+oracle
    return b'HNC1'+data
stats={'cases':0,'exactNumbers':0,'dbNumbers':0,'maxDbError':0.0,'fields':0}
def compare(a,e,path,key=''):
    if isinstance(e,dict):
        assert isinstance(a,dict) and a.keys()==e.keys(),(path,'optional fields',a,e)
        for k,v in e.items():compare(a[k],v,path+'.'+k,k)
    elif isinstance(e,list):
        assert isinstance(a,list) and len(a)==len(e),(path,'length')
        for i,(v,w) in enumerate(zip(a,e)):compare(v,w,f'{path}[{i}]',key)
    elif isinstance(e,(int,float)) and not isinstance(e,bool) or isinstance(e,str) and e in ('NaN','+Infinity','-Infinity','-0'):
        a,e=number(a),number(e)
        if not math.isfinite(e):assert (math.isnan(a) and math.isnan(e)) or a==e,(path,a,e)
        elif key in ('db','avgHNR','partialMeanHNR') or path.startswith('scalar-'):
            error=abs(a-e);assert math.isfinite(a) and error<=1e-10,(path,a,e,error)
            stats['dbNumbers']+=1;stats['maxDbError']=max(stats['maxDbError'],error)
        else:assert struct.pack('<d',a)==struct.pack('<d',e),(path,a,e);stats['exactNumbers']+=1
    else:assert a==e,(path,a,e);stats['fields']+=1
def main():
    manifest=verify();driver=ROOT/'target/release/examples/harmonicity_driver.exe';work=Path(tempfile.mkdtemp(prefix='hnr-',dir=ROOT/'_work'));failures=[]
    for case in manifest['cases']:
        file=work/(case['name']+'.hnc1');file.write_bytes(protocol(case))
        try:
            run=subprocess.run([str(driver),str(file)],capture_output=True,text=True,timeout=30)
            assert run.returncode==0,(case['name'],run.stderr)
            compare(json.loads(run.stdout,parse_int=float),case['expected'],case['name']);stats['cases']+=1
        except (AssertionError,ValueError) as error:failures.append({'case':case['name'],'error':str(error)})
    states_path=ROOT/'phase4/states/manifest.json'
    assert sha(states_path)=='735624c157ed7df5b6b75cda477e156af744bbd0bc91886151dedf5dc160bd67'
    states=json.loads(states_path.read_text(encoding='utf8'))
    assert states['sourceSha256']==sha(ROOT/'_work/baseline/utils/phonetic/harmonicity.js')
    for case in states['cases']:
        payload=ROOT/'phase4/states'/case['input'];assert sha(payload)==case['inputSha256']
        file=work/(case['name']+'.state.hnc1');data=payload.read_bytes();file.write_bytes(b'HNC1\x05'+struct.pack('<I',len(data)//4)+data)
        try:
            run=subprocess.run([str(driver),str(file)],capture_output=True,text=True,timeout=30);assert run.returncode==0,(case['name'],run.stderr)
            compare(json.loads(run.stdout,parse_int=float),case['expected'],case['name']);stats['cases']+=1
        except (AssertionError,ValueError) as error:failures.append({'case':case['name'],'error':str(error)})
    report={'status':'PASS' if not failures else 'FAIL','profile':manifest['profile'],'manifestSha256':MANIFEST_SHA,'stateCases':len(states['cases']),'driverSha256':sha(driver),'stats':stats,'failures':failures,'mathDependency':'Frozen actual-JS scalar sin oracle, not a qualified native libm backend.'}
    (ROOT/'reports/hnr-native.json').write_bytes((json.dumps(report,indent=2)+'\n').encode('utf8'))
    print(json.dumps(report,indent=2));raise SystemExit(1 if failures else 0)
if __name__=='__main__':main()
