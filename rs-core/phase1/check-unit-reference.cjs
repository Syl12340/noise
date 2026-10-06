'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {StrictComparator,number}=require('./strict-compare.cjs');
const root=path.resolve(__dirname,'..'),reference=path.join(__dirname,'reference_units');
const driver=path.join(root,'target/release/examples/acoustics_driver'+(process.platform==='win32'?'.exe':''));
const manifest=JSON.parse(fs.readFileSync(path.join(reference,'manifest.json'),'utf8'));
for(const [name,id] of Object.entries(manifest.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(reference,name))).digest('hex'),id.sha256,name);
const comparator=new StrictComparator();
const work=fs.mkdtempSync(path.join(root,'_work/acoustics-unit-'));
function f64(values){const b=Buffer.alloc(values.length*8);values.forEach((v,i)=>b.writeDoubleLE(number(v,'input'),i*8));return b;}
function run(payload,name){const h=Buffer.alloc(12);h.write('NAC1');h.writeDoubleLE(100,4);const file=path.join(work,name+'.nac1');fs.writeFileSync(file,Buffer.concat([h,payload]));const r=spawnSync(driver,[file],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').map(s=>JSON.parse(s));}
const scalars=JSON.parse(fs.readFileSync(path.join(reference,'scalars.json'),'utf8'));
for(let i=0;i<scalars.length;i++){
 const test=scalars[i];let packet;
 if(test.kind==='rms'){const h=Buffer.alloc(6);h[0]=7;h[1]=9;h.writeUInt32LE(test.input.length,2);packet=Buffer.concat([h,f64(test.input)]);}
 else {packet=Buffer.concat([Buffer.from([7,{db:4,leq:5,cne:8}[test.kind]]),f64(test.args)]);}
 const rows=run(packet,'scalar-'+i),row=rows.find(r=>r.type==='scalar');assert.ok(row);
 comparator[test.kind==='rms'?'rms':'db'](row.result,test.expected,`scalar ${i}/${test.kind}`);
}
for(const name of ['zero','tone','dc_step','nyquist']){
 const expected=JSON.parse(fs.readFileSync(path.join(reference,name+'.json'),'utf8'));
 const rows=run(Buffer.concat([Buffer.from([6]),fs.readFileSync(path.join(reference,name+'.f64le'))]),name);
 const actual=rows.find(r=>r.type==='unit_spectrum');assert.ok(actual);
 comparator.array(actual.raw_powers,expected.linear_bins,'float',name+'/raw power');
 comparator.array(actual.linear_bins,expected.linear_bins.map(v=>Math.max(v,1e-24)),'float',name+'/floor power');
 comparator.array(actual.spectrum_db,expected.spectrum_db,'db',name+'/db');
 comparator.array(actual.bands_db,expected.bands_db,'db',name+'/bands');
}
const report={status:'PASS',scalarCases:scalars.length,spectrumCases:4,...comparator.stats,
 driverSha256:crypto.createHash('sha256').update(fs.readFileSync(driver)).digest('hex'),
 scope:'Actual baseline functions vs native Rust; neither device verification nor independent physical truth'};
fs.writeFileSync(path.join(root,'reports/acoustics-unit-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
