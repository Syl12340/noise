"""Independent P0 replay: no copied JavaScript signal pipeline and no golden writes."""
from pathlib import Path
import json, math, struct, subprocess, tempfile, hashlib, sys
ROOT=Path(__file__).resolve().parents[1]
FIX=ROOT/'phase0/fixtures'
DRIVER=ROOT/'target/release/examples/acoustics_driver.exe'
WASM_MODE='--wasm' in sys.argv[1:]
COMMAND=['node',str(ROOT/'phase2/wasm-nac-driver.cjs')] if WASM_MODE else [str(DRIVER)]
PROFILE=json.loads((ROOT/'phase1/NUMERIC_PROFILE_V1.json').read_text(encoding='utf-8'))
stats={'exactFloats':0,'exactFields':0,'dbFields':0,'maxDbError':0.0}
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def number(v):
    if isinstance(v,(int,float)) and not isinstance(v,bool):return v
    if v in ['NaN','+Infinity','-Infinity']:return {'NaN':math.nan,'+Infinity':math.inf,'-Infinity':-math.inf}[v]
    raise AssertionError(('invalid number',v))
def exact(a,b,label):
    assert a==b,(label,a,b)
    stats['exactFields']+=1
def floating(a,b,label):
    a,b=number(a),number(b)
    assert struct.pack('<d',a)==struct.pack('<d',b),(label,a,b)
    stats['exactFloats']+=1
def db(a,b,label):
    a,b=number(a),number(b)
    if not math.isfinite(b):assert (math.isnan(a) and math.isnan(b)) or a==b,(label,a,b)
    else:
        assert math.isfinite(a),(label,a,b)
        diff=abs(a-b);assert diff<=PROFILE['acceptance']['finiteDbAbsolute'],(label,a,b,diff)
        stats['maxDbError']=max(stats['maxDbError'],diff)
    stats['dbFields']+=1
def invalid(reason):
    raw=reason.encode('utf-8');return b'\x04'+struct.pack('<I',len(raw))+raw
def replay(folder,work):
    expected=load(folder/'expected.json');chunks=load(folder/'chunks.json');events=load(folder/'events.json')
    pcm=(folder/'pcm.i16le').read_bytes()
    data=[b'NAC1'+struct.pack('<d',100)];mode='waveform';seq=1;handled=set();receipts=[]
    for chunk in chunks:
        for i,event in enumerate(events):
            if i in handled or event.get('sampleCursor')!=chunk['sampleStart']:continue
            if event.get('event')=='switchView':
                handled.add(i)
                if mode!=event['mode']:
                    mode=event['mode']
                    if mode in ['spectrum','spectrogram']:data.append(b'\x02')
            elif event.get('event')=='emitSystemEvent':
                handled.add(i);data.append(invalid(chunk['invalidReason'] or 'system_interruption'))
        damaged=chunk['disposition']=='Rejected(InvalidFormat)'
        if damaged:data.append(invalid(chunk['invalidReason'] or 'invalid_format'))
        raw=b'' if damaged else pcm[chunk['sampleStart']*2:chunk['sampleEnd']*2]
        data.append(b'\x01'+struct.pack('<IIB',seq,len(raw)//2,int(mode in ['spectrum','spectrogram']))+raw)
        data.append(b'\x05')
        if chunk['disposition'].startswith('Committed') or chunk['disposition'].startswith('TerminalRejected'):seq+=1
    invalid_finish=any(e.get('event')=='stopTimeout' for e in events)
    data.extend([b'\x03'+bytes([invalid_finish]),b'\x03'+bytes([invalid_finish])])
    file=work/(folder.name+'.nac1');file.write_bytes(b''.join(data))
    run=subprocess.run(COMMAND+[str(file)],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',timeout=30)
    assert run.returncode==0,(folder.name,run.returncode,run.stderr)
    rows=[json.loads(line) for line in run.stdout.splitlines() if line]
    assert not any(r['type']=='error' for r in rows)
    snapshots=[r for r in rows if r['type']=='snapshot'];native_receipts=[r for r in rows if r['type']=='receipt']
    exact(len(snapshots),len(chunks),'snapshot count');exact(len(native_receipts),len(chunks),'receipt count')
    accepted=iter(expected['receipts']);last_energy=0.0
    for chunk,snapshot,receipt in zip(chunks,snapshots,native_receipts):
        count=chunk.get('sampleCount',chunk.get('stateAfter',{}).get('sampleCount'))
        exact(snapshot['total_a_samples'],count,'chunk samples')
        energy=chunk.get('energySum',last_energy);floating(snapshot['total_a_energy'],energy,'chunk energy');last_energy=energy
        label=chunk['disposition']
        status=('committed' if label.startswith('Committed') else 'terminated_q_only' if label.startswith('TerminalRejected')
                else 'ignored_empty' if label=='IgnoredEmptyChunk' else 'ignored_after_termination')
        exact(receipt['status'],status,'receipt status')
        if 'inspector' in chunk:
            q=chunk['inspector'];n=snapshot['inspector']
            for nk,qk in [('samples','samples'),('rails','rails'),('max_rails','maxRails'),('max_consecutive_rails','maxRailRun'),('clipped','clipped'),('plateau_suspected','plateauSuspected')]:exact(n[nk],q[qk],nk)
            exact(n['intervals'],q['clippedIntervals'],'clip intervals')
        if label.startswith('Committed'):
            ref=next(accepted)
            exact(snapshot['silent_samples'],ref['silentSampleCount'],'silent count')
            exact(snapshot['consecutive_silent_samples'],ref['consecutiveSilentSampleCount'],'consecutive silent count')
            exact(snapshot['near_full_scale_observed'],ref['inputNearFullScale'],'near-full warning')
            db(receipt['chunk_dbfs'],ref['lastFrameLevels']['dbfs'],'block dbfs')
            db(receipt['chunk_dbspl'],ref['lastFrameLevels']['dbspl'],'block spl')
    windows=[r for r in rows if r['type']=='window'];exact(len(windows),len(expected['secondWindows']),'windows')
    for actual,ref in zip(windows,expected['secondWindows']):
        for a,b in [('second','boundaryIndex'),('exclusive_end','totalAWeightedSampleCount'),('interval_z_samples','intervalZWeightedSampleCount'),('cumulative_a_samples','totalAWeightedSampleCount')]:exact(actual[a],ref[b],a)
        for a,b in [('interval_z_energy','intervalZWeightedEnergySum'),('cumulative_a_energy','totalAWeightedEnergySum')]:floating(actual[a],ref[b],a)
        for a,b in [('interval_dbspl_z','intervalDbsplZ'),('chunk_dbfs','dbfsZ'),('chunk_dbspl','dbsplZ')]:db(actual[a],ref[b],a)
    spectra=[r for r in rows if r['type']=='spectrum' and 'spectrum_db' in r]
    observations=expected['spectrum'].get('observations',[]);exact(len(spectra),len(observations),'spectra count')
    blob=(folder/'spectra.f64le').read_bytes() if observations else b''
    for actual,ref in zip(spectra,observations):
        exact(actual['at_sample'],ref['sampleCount'],'spectrum position')
        exact(actual['source'],'query' if ref['origin']=='view-query' else 'scheduled','spectrum source')
        bins=struct.unpack_from('<16384d',blob,ref['byteOffset']);exact(len(actual['spectrum_db']),16384,'bins')
        for a,b in zip(actual['spectrum_db'],bins):db(a,b,'bin db')
        exact(len(actual['bands_db']),29,'bands')
        for a,b in zip(actual['bands_db'],ref['bands29']):db(a,b,'band db')
    finals=[r for r in rows if r['type']=='final'];exact(len(finals),2,'finish count');exact(finals[0],finals[1],'idempotent finish')
    final=finals[0];exact(final['total_samples'],expected['sampleCount'],'final count');floating(final['a_energy'],expected['aWeightedEnergy'],'final energy')
    if expected['leqA'] is not None:db(final['leq_a'],expected['leqA'],'final Leq')
    tail=expected['filterTail']
    if tail is None:exact(final['tail'],None,'no tail')
    else:
        floating(final['tail']['energy'],tail['energy'],'tail energy');exact(final['tail']['padding_samples'],tail['paddingSamples'],'tail samples');exact(final['tail']['converged'],tail['converged'],'tail convergence')
    return {'id':folder.name,'samples':final['total_samples'],'windows':len(windows),'spectra':len(spectra),'status':'PASS'}
def main():
    work=Path(tempfile.mkdtemp(prefix='p0-native-',dir=ROOT/'_work'))
    results=[]
    for folder in sorted(FIX.glob('fix*')):
        results.append(replay(folder,work));print(folder.name,'PASS',flush=True)
    report={'status':'PASS','fixtureCount':len(results),'fixtures':results,**stats,
            'backend':'wasm' if WASM_MODE else 'native',
            'driverSha256':hashlib.sha256((ROOT/'phase2/wasm-nac-driver.cjs' if WASM_MODE else DRIVER).read_bytes()).hexdigest(),
            'scope':'Frozen core fields only; calibration/capture integrity/risk/save remain application-owned.'}
    if WASM_MODE:
        report['wasmSha256']=hashlib.sha256((ROOT/'target/wasm32-unknown-unknown/release/noise_wasm.wasm').read_bytes()).hexdigest()
        report['hostSha256']=hashlib.sha256((ROOT/'phase2/noise-host.cjs').read_bytes()).hexdigest()
        report['scope']+=' Application invalidation text is mapped to bounded ABI codes; free-form text is not a core result.'
    report_name='acoustics-p0-wasm-comparison.json' if WASM_MODE else 'acoustics-p0-native-comparison.json'
    (ROOT/'reports'/report_name).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='fixtures'},ensure_ascii=False))
if __name__=='__main__':main()
