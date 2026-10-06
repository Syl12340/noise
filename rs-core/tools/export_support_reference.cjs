'use strict';
// One-time capture of actual baseline functions. Never regenerates an existing manifest.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(root,'_work/baseline');
const out=path.join(root,'phase6/reference/manifest.json');
if(fs.existsSync(out))throw new Error('Reference already frozen');
const support=require(path.join(base,'utils/phonetic/time-support.js'));
const source=path.join(base,'utils/phonetic/analysis.js'),m=new Module(source);
m.filename=source;m.paths=Module._nodeModulePaths(path.dirname(source));
m._compile(fs.readFileSync(source,'utf8')+'\nmodule.exports.captureInvalidateIntervals=invalidateIntervals;\n',source);
const cases=[
 {name:'filter-edges',times:[0,512/12000,.1,.95,1],window:1024/12000,margin:128/44100,duration:1,intervals:[]},
 {name:'touch-and-overlap',times:[.125,.375,.625,.875],window:.25,margin:0,duration:1,intervals:[{start:.25,end:.5}]},
 {name:'overlapping-unsorted',times:[.1,.2,.3,.4],window:.1,margin:.01,duration:.5,intervals:[{start:.3,end:.45},{start:.05,end:.2},{start:.15,end:.25}]},
 {name:'empty',times:[],window:.1,margin:0,duration:0,intervals:[]},
 {name:'both-flags',times:[0,.01,.02],window:1024/12000,margin:128/48000,duration:.02,intervals:[{start:0,end:.02}]},
 {name:'odd-window',times:[260.5/12000,379.5/12000,.1],window:521/12000,margin:128/22050,duration:.2,intervals:[{start:.06,end:.08}]},
 {name:'max-rows',times:Array.from({length:4096},(_,i)=>i/12000),window:256/12000,margin:128/32000,duration:4096/12000,intervals:[{start:.1,end:.2}]},
];
for(const c of cases){
 const rows=support.addSupport(c.times.map(time=>({time,f0:200})),c.window,c.margin);
 m.exports.captureInvalidateIntervals(rows,c.intervals);
 c.expected=rows.map(r=>({time:r.time,support:r.support,incompleteFilterSupport:support.supportCrossesBoundary(r,[0,c.duration]),clipped:r.reason==='clipped-input'}));
}
fs.mkdirSync(path.dirname(out),{recursive:true});
const sources={};for(const p of ['utils/phonetic/time-support.js','utils/phonetic/analysis.js'])sources[p]=crypto.createHash('sha256').update(fs.readFileSync(path.join(base,p))).digest('hex');
fs.writeFileSync(out,JSON.stringify({baseline:'3a0d6765147c56d2a73e1cec78f6106ae2e681ab',sources,cases},null,2)+'\n');
console.log(crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
