from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]/'phase0/fixtures'
for prefix in ['fix05','fix17','fix18','fix19','fix20','fix23']:
 folder=next(p for p in root.iterdir() if p.name.startswith(prefix))
 events=json.loads((folder/'events.json').read_text(encoding='utf-8'))
 chunks=json.loads((folder/'chunks.json').read_text(encoding='utf-8'))
 expected=json.loads((folder/'expected.json').read_text(encoding='utf-8'))
 print(json.dumps({'id':folder.name,'events':[e for e in events if e.get('type')!='chunk'][:12],
 'firstChunk':chunks[0],'finalChunk':chunks[-1], 'expectedKeys':list(expected),
 'windowFirst':expected['secondWindows'][:1], 'receiptFirst':expected['receipts'][:1]},ensure_ascii=False))
