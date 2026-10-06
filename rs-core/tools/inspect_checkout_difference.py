from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parents[1]
report=json.loads((root/'reports/staged-checkout-verification.json').read_text(encoding='utf8'))
copy=Path(report['copy'])
for name in ['app.json','pages/main/main.js','utils/audio-math.js','project.config.json']:
    a=(root.parent/name).read_bytes();b=(copy/name).read_bytes()
    start=next((i for i,(x,y) in enumerate(zip(a,b)) if x!=y),None)
    print(json.dumps({'path':name,'workingBytes':len(a),'copyBytes':len(b),'workingSha':hashlib.sha256(a).hexdigest(),'copySha':hashlib.sha256(b).hexdigest(),'firstDifference':start,'workingPrefix':repr(a[:30]),'copyPrefix':repr(b[:30]),'localSegment':repr(a[max(0,(start or 0)-20):(start or 0)+40]),'copySegment':repr(b[max(0,(start or 0)-20):(start or 0)+40])}))
