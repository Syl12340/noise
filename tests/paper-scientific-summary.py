"""Summarize preserved reports and independent analytic diagnostics."""
from pathlib import Path
import hashlib
import json
import math
import tempfile
import subprocess
import shutil
import sys
import datetime
import re

ROOT = Path(__file__).resolve().parents[1]
output_name = sys.argv[sys.argv.index('--output-name') + 1] if '--output-name' in sys.argv else 'scientific-validation-2026-10-05'
if not re.fullmatch(r'[a-z0-9-]+', output_name):
    raise ValueError('Output must be a directory name within docs')
OUT = ROOT / 'docs' / output_name

def read(name):
    return json.loads((OUT / name).read_text(encoding='utf-8'))

def main():
    if '--followup' in sys.argv:
        manifest = read('run-manifest.json')
        stage = Path(manifest['isolatedWorkingDirectory'])
        name = 'paper-scientific-followup-probes'
        shutil.copy2(ROOT / ('tests/'+name+'.cjs'), stage / ('tests/'+name+'.cjs'))
        start = datetime.datetime.now(datetime.timezone.utc)
        command = ['node','tests/'+name+'.cjs']
        run = subprocess.run(command,cwd=stage,capture_output=True,text=True,encoding='utf-8',timeout=240)
        (OUT/(name+'.log')).write_text(run.stdout+'\nSTDERR:\n'+run.stderr,encoding='utf-8')
        manifest['commands'].append({'command':command,'exitCode':run.returncode,
            'seconds':(datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),'log':name+'.log'})
        if (stage/('docs/'+name+'-results.json')).exists():
            shutil.copy2(stage/('docs/'+name+'-results.json'),OUT/(name+'-results.json'))
        (OUT/'run-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print('Follow-up exit=',run.returncode,flush=True)
    result = {}
    for name in ['formant-validation-results.json', 'formant-holdout-results.json']:
        report = read(name)
        slots = []
        for k in range(3):
            inside = [case for case in report['cases'] if 90 <= case['poles'][k][0] <= 5000
                      and case['poles'][k][1] <= 500 and case['poles'][k][0] >= 1.5 * case['f0']]
            true = sum(case['stats'][k]['truthFrames'] for case in inside)
            accepted = sum(case['stats'][k]['acceptedFrames'] for case in inside)
            wrong = sum(case['stats'][k]['wrongAcceptedFrames'] for case in inside)
            slots.append({'formant': k+1, 'conditions': len(inside), 'truthFrames': true,
                          'acceptedFrames': accepted, 'coverage': accepted/true,
                          'wrongAcceptedFrames': wrong,
                          'maxRelativeError': max((case['stats'][k]['maxRelativeErrorAmongAccepted'] or 0) for case in inside)})
        result[name] = {'withinDeclaredPerPoleDomain': slots,
                        'note': 'Post hoc descriptive stratification, not replacement acceptance gate; F2/F3 may still depend on a rejected lower pole.',
                        'allConditionsHave30Rows': all(all(s['truthFrames'] == 30 for s in case['stats']) for case in report['cases'])}
    analytic = []
    for f0 in [100,173,200,237,389,599]:
        harmonics = math.floor(5000/f0)
        weights = [1/k for k in range(1,harmonics+1)]
        r = lambda lag: sum(w*math.cos(2*math.pi*k*f0*lag/12000) for k,w in enumerate(weights,1))/sum(weights)
        tau = 12000/f0
        m = max([math.floor(tau), math.ceil(tau)], key=r)
        left, centre, right = r(m-1), r(m), r(m+1)
        delta = .5*(left-right)/(left-2*centre+right)
        peak = centre - .25*(left-right)*delta
        clipped = min(peak,1-1e-6)
        analytic.append({'f0':f0, 'harmonics':harmonics, 'truePeriodSamples':tau,
                         'trueAutocorrelationAtPeriod':r(tau), 'threePointPeak':peak,
                         'impliedHnrDb':10*math.log10(clipped/(1-clipped))})
    result['analyticPeriodicAutocorrelation'] = analytic
    probes = read('paper-scientific-probes-results.json')
    result['noiselessFloatHnr'] = [row for row in probes['hnr'] if row['noiseless']]
    result['noisyHnr'] = [row for row in probes['hnr'] if row['f0']==237 and not row['noiseless']]
    result['resampling'] = probes['resampling']
    result['limits'] = 'Synthetic diagnostics; no significance tests; overlapping frames are dependent; no IEC or clinical claim.'
    (OUT / 'independent-analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:value for key,value in result.items() if key in
        ['formant-validation-results.json','formant-holdout-results.json','noisyHnr','resampling']},ensure_ascii=False))
    manifest = read('run-manifest.json')
    manifest['validationHarnessSha256'] = {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
        for name in ['tests/paper-scientific-validation.py','tests/paper-scientific-probes.cjs','tests/paper-scientific-summary.py','tests/paper-scientific-followup-probes.cjs']}
    manifest['originalFilesUnchanged'] = all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==value for name,value in manifest['sourceSnapshot'].items())
    document = ROOT/'docs/paper-scientific-validation-2026-10-05.md'
    if document.exists():
        body = document.read_text(encoding='utf-8')
        missing = [link for link in re.findall(r'\]\(([^)]+)\)',body)
                   if not link.startswith(('https://','http://','#')) and not (document.parent/link).is_file()]
        assert not missing, missing
        assert body.count('$$') % 2 == 0
        assert all(line.rstrip()==line for line in body.splitlines())
        assert manifest['originalFilesUnchanged']
        manifest['verificationReportSha256'] = hashlib.sha256(document.read_bytes()).hexdigest()
        manifest['documentChecks'] = {'localLinksExist':True,'displayMathBalanced':True,'noTrailingWhitespace':True}
    (OUT/'run-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Document and source preservation checks:',json.dumps(manifest.get('documentChecks',{})),manifest['originalFilesUnchanged'])

if __name__ == '__main__':
    main()
