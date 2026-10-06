"""Read-only syntax/runtime preflight; no fixture freeze or baseline writes."""
from pathlib import Path
import json
import subprocess

root=Path(__file__).resolve().parents[1]
checks=[]
for args in [
    ['node','--check','tools/freeze-vectors.cjs'],
    ['node','-e',"const f=require('./tools/freeze-vectors.cjs'); for (const d of f.FIXTURE_DEFINITIONS) { try { const r=f.executeFixture(d); console.log(JSON.stringify({id:d.id,completed:!!r.completedSnapshot,sampleCount:r.completedSnapshot?.sampleCount,dataQuality:r.dataQuality,canSave:r.canSave,windows:r.secondWindows.length,spectrum:r.spectrumSummary?.status,modal:r.modalTriggered,firstDisposition:r.chunksMeta[0]?.disposition})); } catch(e) {console.log(JSON.stringify({id:d.id,error:e.stack}));process.exitCode=1;} } console.log(JSON.stringify({domain:f.generateDecisionBoundaryCorpus()}));"],
]:
    run=subprocess.run(args,cwd=root,capture_output=True,text=True,encoding='utf-8',timeout=30)
    checks.append({'command':args,'exitCode':run.returncode,'stdout':run.stdout,'stderr':run.stderr})
out=root/'reports/tool-preflight.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({'scope':'Tooling preflight only; no frozen fixture or scientific validation claim','checks':checks},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for check in checks:
    print(check['command'][:2],check['exitCode'])
    if check['stdout']:print(check['stdout'][:14000])
    if check['stderr']:print(check['stderr'][:1800])
