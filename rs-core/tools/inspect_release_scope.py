"""Inventory proposed commit scope; ignored build/scratch files never enter release."""
from pathlib import Path
import json,subprocess
root=Path(__file__).resolve().parents[1]
project=root.parent
run=subprocess.run(['git','ls-files','--others','--exclude-standard','--','rs-core'],cwd=project,check=True,capture_output=True)
names=run.stdout.decode('utf8').splitlines()
files=[(name,(project/name).stat().st_size) for name in names]
print(json.dumps({'files':len(files),'bytes':sum(s for _,s in files),'largest':sorted(files,key=lambda v:v[1],reverse=True)[:8]},indent=2))
assert all('/target/' not in n and '/_work/' not in n for n,_ in files)
assert all(s < 100*1024*1024 for _,s in files)
