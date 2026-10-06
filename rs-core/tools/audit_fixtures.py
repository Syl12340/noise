"""Read frozen fixtures and preserve independent payload identities and evidence."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
fixtures = root / 'phase0/fixtures'
reports = root / 'reports'
manifest = json.loads((fixtures/'manifest.json').read_text(encoding='utf-8'))
assert manifest['fixtureCount'] == 26
rows = []
for name, identity in manifest['fixtures'].items():
    folder = fixtures/name
    expected = json.loads((folder/'expected.json').read_text(encoding='utf-8'))
    chunks = json.loads((folder/'chunks.json').read_text(encoding='utf-8'))
    assert hashlib.sha256((folder/'pcm.i16le').read_bytes()).hexdigest() == identity['pcmSha256']
    assert hashlib.sha256((folder/'expected.json').read_bytes()).hexdigest() == identity['expectedSha256']
    assert expected['sampleCount'] == chunks[-1]['sampleCount']
    for chunk in chunks:
        if chunk['disposition'].startswith('TerminalRejected'):
            assert chunk['sampleCount'] < chunk['sampleEnd']
    spectrum = expected['spectrum']
    if spectrum['status'] == 'available':
        raw = (folder/'spectra.f64le').read_bytes()
        assert len(raw) == spectrum['observationCount'] * 16384 * 8
        assert hashlib.sha256(raw).hexdigest() == spectrum['sha256']
        assert all(len(o['bands29']) == 29 and o['origin'] in ['view-query','scheduled-frame'] for o in spectrum['observations'])
    rows.append({'id':name,'sampleCount':expected['sampleCount'], 'dataQuality':expected['dataQuality'],
                 'canSave':expected['canSave'], 'windows':expected['secondWindowCount'],
                 'spectrumCount':spectrum.get('observationCount',0), 'modalTriggered':expected['modalTriggered']})
assert next(r for r in rows if r['id'].startswith('fix23'))['canSave'] is True
assert next(r for r in rows if r['id'].startswith('fix25'))['windows'] == 2
assert next(r for r in rows if r['id'].startswith('fix26'))['modalTriggered'] is True
payload = {p.relative_to(fixtures).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
           for p in sorted(fixtures.rglob('*')) if p.is_file() and p.name != 'README.md'}
result = {'status':'PASS','baselineCommit':manifest['baselineCommit'], 'fixtureCount':len(rows),
          'payloadFileCount':len(payload), 'payloadHashes':payload, 'fixtures':rows,
          'scope':'Synthetic JavaScript baseline evidence; no Rust, real-device or clinical validation.'}
(reports/'fixture-independent-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n', encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k not in ['payloadHashes','fixtures']},ensure_ascii=False))
