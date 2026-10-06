"""Native port vs actual JS frozen outputs. Every Float32 byte must match."""
from pathlib import Path
import hashlib,json,struct,subprocess
ROOT=Path(__file__).resolve().parents[1]
REF=ROOT/'phase3/resample-reference'
TABLE=ROOT/'coefficients/speech-resample-12000-v1'
REFERENCE_SHA='4af3fe3d906a17f257bfd82f4a35be60cfa08df188ce8bad3c8d6a4ede2bce21'
TABLES_SHA='89b844a364df0da8418cb621ba0155fbe4b2c72f807b36bc7dfdea96ade8fd6a'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def verify():
    assert sha(REF/'manifest.json')==REFERENCE_SHA,'Reference changed'
    assert sha(TABLE/'manifest.json')==TABLES_SHA,'Table manifest changed'
    manifest=json.loads((REF/'manifest.json').read_text(encoding='utf8'))
    assert sha(ROOT/'_work/baseline/utils/phonetic/resample.js')==manifest['sourceSha256']
    tables=json.loads((TABLE/'manifest.json').read_text(encoding='utf8'))
    for name,identity in tables['files'].items():
        data=(TABLE/name).read_bytes()
        assert hashlib.sha256(data).hexdigest()==identity['sha256']
        assert data[:4]==b'RSK1' and struct.unpack_from('<II',data,4)==(identity['inputRate'],12000)
        assert struct.unpack_from('<d',data,12)[0]==5500
        count=struct.unpack_from('<I',data,20)[0]
        assert len(data)==24+count*(4+257*8)
        assert [struct.unpack_from('<I',data,24+i*(4+257*8))[0] for i in range(count)]==identity['phases']
    for case in manifest['cases']:
        assert sha(REF/case['input'])==case['inputSha256']
        assert sha(REF/case['output'])==case['outputSha256']
    return manifest
def main():
    manifest=verify();driver=ROOT/'target/release/examples/speech_driver.exe';cases=[];samples=0
    for case in manifest['cases']:
        argv=[str(driver),'resample',str(REF/case['input']),str(case['inputRate']),str(case['outputRate']),str(case['cutoffHz'])]
        run=subprocess.run(argv,check=True,capture_output=True,text=True,timeout=30)
        values=json.loads(run.stdout)
        actual=struct.pack('<'+str(len(values))+'f',*values)
        assert len(values)==case['outputSamples'],case['name']
        assert actual==(REF/case['output']).read_bytes(),case['name']
        samples+=len(values);cases.append(case['name'])
    report={'status':'PASS','cases':len(cases),'float32Bits':samples,'referenceSha256':REFERENCE_SHA,'tablesSha256':TABLES_SHA,'driverSha256':sha(driver),'scope':'Seven frozen 12kHz profiles; full phonetic pipeline and device capture unverified.'}
    (ROOT/'reports/resample-native.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(json.dumps(report))
if __name__=='__main__':main()
