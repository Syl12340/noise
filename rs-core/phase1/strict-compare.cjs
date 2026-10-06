'use strict';
const assert=require('node:assert/strict');
const profile=require('./NUMERIC_PROFILE_V1.json').acceptance;
function number(value,label) {
 if(typeof value==='number') return value;
 if(value==='NaN') return NaN;
 if(value==='+Infinity') return Infinity;
 if(value==='-Infinity') return -Infinity;
 throw new Error(`${label}: missing or invalid numeric value ${String(value)}`);
}
function sameClass(actual,expected,label) {
 if(Number.isNaN(expected)) {assert.ok(Number.isNaN(actual),`${label}: expected NaN`);return true;}
 if(!Number.isFinite(expected)) {assert.equal(actual,expected,`${label}: nonfinite mismatch`);return true;}
 assert.ok(Number.isFinite(actual),`${label}: finite expected but actual=${actual}`);return false;
}
class StrictComparator {
 constructor(){this.stats={exactFields:0,exactFloats:0,dbFields:0,rmsFields:0,maxDbError:0,maxRmsError:0};}
 exact(actual,expected,label){assert.notEqual(actual,undefined,`${label}: missing`);assert.deepEqual(actual,expected,label);this.stats.exactFields++;}
 float(actual,expected,label){const a=number(actual,label),e=number(expected,label);if(!sameClass(a,e,label)){const ab=Buffer.alloc(8),eb=Buffer.alloc(8);ab.writeDoubleLE(a);eb.writeDoubleLE(e);assert.equal(ab.toString('hex'),eb.toString('hex'),`${label}: algebra not bit-exact (${a},${e})`);}this.stats.exactFloats++;}
 db(actual,expected,label){const a=number(actual,label),e=number(expected,label);if(!sameClass(a,e,label)){const diff=Math.abs(a-e);assert.ok(diff<=profile.finiteDbAbsolute,`${label}: dB error ${diff}`);this.stats.maxDbError=Math.max(this.stats.maxDbError,diff);}this.stats.dbFields++;}
 rms(actual,expected,label){const a=number(actual,label),e=number(expected,label);if(!sameClass(a,e,label)){const diff=Math.abs(a-e);assert.ok(diff<=profile.rmsAbsoluteFactorEpsilon*profile.epsilon*Math.max(1,Math.abs(e)),`${label}: RMS error ${diff}`);this.stats.maxRmsError=Math.max(this.stats.maxRmsError,diff);}this.stats.rmsFields++;}
 array(actual,expected,mode,label){assert.ok(Array.isArray(actual)&&Array.isArray(expected),`${label}: missing array`);assert.equal(actual.length,expected.length,`${label}: length`);for(let i=0;i<expected.length;i++)this[mode](actual[i],expected[i],`${label}[${i}]`);}
}
module.exports={StrictComparator,number};
if(require.main===module){
 const c=new StrictComparator();c.float(1,1,'equal');c.db('NaN',NaN,'nan');
 assert.throws(()=>c.db('NaN',1,'must-reject-nan'));
 assert.throws(()=>c.rms(undefined,1,'must-reject-missing'));
 assert.throws(()=>c.float(1+Number.EPSILON,1,'must-reject-one-ulp'));
 assert.throws(()=>c.float(-0,0,'signed-zero'));
 assert.throws(()=>c.array([1],[1,2],'float','array-length'));
 console.log(JSON.stringify({status:'PASS',scope:'Comparator guards; not Rust algorithm validation'}));
}
