"""Read-only remote inspection with interactive credential prompts disabled."""
import json,os,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
env=dict(os.environ,GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
rows=[]
for name in ('origin','github'):
    run=subprocess.run(['git','ls-remote',name,'refs/heads/master'],cwd=root,env=env,capture_output=True,text=True,timeout=40)
    rows.append({'remote':name,'exitCode':run.returncode,'stdout':run.stdout.strip(),'stderr':run.stderr.strip()})
print(json.dumps(rows,indent=2))
