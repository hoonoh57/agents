import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = JSON.parse(fs.readFileSync(path.join(root,'registry','model_benchmark_candidates.json'),'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(root,'registry','model_benchmark_cases_v3.json'),'utf8'));
const base = 'http://127.0.0.1:11434';
const arg = (n,d=null) => { const i=process.argv.indexOf(`--${n}`); return i>=0&&i+1<process.argv.length?process.argv[i+1]:d; };
const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const has = (a,b) => String(a??'').toLowerCase().includes(String(b).toLowerCase());
const r2 = n => Math.round(n*100)/100;

function parseOne(raw){
  const t=String(raw??'').trim();
  try{return{value:JSON.parse(t),strict:true,recovered:false,trailing:0,error:null};}catch(e){
    const s=t.indexOf('{'); if(s<0){return{value:null,strict:false,recovered:false,trailing:t.length,error:String(e.message)};
    let d=0,q=false,esc=false,end=-1;
    for(let i=s;i<t.length;i++){const c=t[i];if(q){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')q=false;continue;}if(c==='"'){q=true;continue;}if(c==='{')d++;else if(c==='}'&&--d===0){end=i;break;}}
    if(end<0)return{value:null,strict:false,recovered:false,trailing:t.length,error:String(e.message)};
    try{const v=JSON.parse(t.slice(s,end+1));const extra=t.slice(0,s).trim().length+t.slice(end+1).trim().length;return{value:v,strict:extra===0,recovered:true,trailing:extra,error:String(e.message)};}catch(x){return{value:null,strict:false,recovered:false,trailing:t.length,error:String(x.message)};}
  }
}
function semantic(c,o){const checks=[];for(const[k,v]of Object.entries(c.expected||{}))checks.push(eq(o?.[k],v));for(const[k,vs]of Object.entries(c.requiredContains||{}))for(const v of vs)checks.push(has(o?.[k],v));for(const[k,vs]of Object.entries(c.forbiddenContains||{}))for(const v of vs)checks.push(!has(o?.[k],v));return checks.length?checks.filter(Boolean).length/checks.length*100:0;}
function contract(c,p){if(!p.value||typeof p.value!=='object'||Array.isArray(p.value))return 0;const o=p.value,s=c.responseSchema,checks=[p.strict];for(const k of s.required||[])checks.push(Object.hasOwn(o,k));if(s.additionalProperties===false){const allowed=new Set(Object.keys(s.properties||{}));checks.push(Object.keys(o).every(k=>allowed.has(k)));}for(const[k,v]of Object.entries(s.properties||{})){if(!Object.hasOwn(o,k))continue;if(v.type==='boolean')checks.push(typeof o[k]==='boolean');else if(v.type==='string')checks.push(typeof o[k]==='string');else if(v.type==='integer')checks.push(Number.isInteger(o[k]));else if(v.type==='number')checks.push(typeof o[k]==='number'&&Number.isFinite(o[k]));else if(v.type==='array')checks.push(Array.isArray(o[k]));if(v.enum)checks.push(v.enum.includes(o[k]));}return checks.filter(Boolean).length/checks.length*100;}
async function call(model,c,ctx){const schema=JSON.stringify(c.responseSchema);const r=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'Return exactly one JSON object matching the schema. No markdown or text before/after JSON.'},{role:'user',content:`${c.prompt}\n\nJSON SCHEMA:\n${schema`}],format:c.responseSchema,stream:false,options:{temperature:0,num_ctx:ctx}})});if(!r.ok)throw new Error(`HTTP_${r.status}`);const d=await r.json();const p=parseOne(d?.message?.content??'');const sec=Number(d.eval_duration||0)/1e9;return{p,tok:sec>0?Number(d.eval_count||0)/sec:null};}
function selfTest(){const a=parseOne('{"x":1}'),b=parseOne('{"x":1}\nextra');if(!a.strict||a.value.x!==1||!b.recovered||b.strict||b.value.x!==1)throw new Error('parser self-test failed');console.log(`[model-benchmark-v4] @SELF_TEST_PASS candidates=${candidates.candidates.length} cases=${cases.cases.length} scorer=chat-schema-grounded-v3`);}
async function run(){const names=String(arg('models','gemma4:12b')).split(',').map(x=>x.trim()).filter(Boolean);const ctx=Math.max(1024,Number(arg('context','4096')));for(const model of names){const cand=candidates.candidates.find(x=>x.model===model);if(!cand)throw new Error(`unregistered:${model}`);console.log(`[model-benchmark-v4] MODEL_START ${model}`);const rows=[];for(const c of cases.cases.filter(x=>cand.roles.includes(x.role))){const x=await call(model,c,ctx);const sem=semantic(c,x.p.value),con=contract(c,x.p),q=sem*.8+con*.2;rows.push({w:c.weight,sem,con,q,tok:x.tok});console.log(`[model-benchmark-v4] CASE_RESULT`+||'');console.log(`[model-benchmark-v4] CASE_RESULT ${model} ${c.caseId} semantic=${r2(sem)} contract=${r2(con)} quality=${r2(q)} strict=${x.p.strict} recovered=${x.p.recovered} trailing=${x.p.trailing} tok_s=${x.tok?.toFixed?.(2)??'l/a'}`);if(!x.p.strict)console.log(`[model-benchmark-v4]   PARSED ${JSON.stringify(x.p.value)}`);}const w=rows.reduce((a,x)=>a+x.w,0)||1,avg=k=>rows.reduce((a,x)=>a+x[k]*x.w,0)/w;const speed=rows.map(x=>x.tok).filter(Number.isFinite);console.log(`[Model-benchmark-v4] MODEL_RESULT ${model} semantic=${r2(avg('sem'))} contract=${r2(avg('con'))} quality=${r2(avg('q'))} tok_s=${speed.length?r2(speed.reduce((a,b)=>a+b,0)/speed.length):'n/a'}`);}}
const cmd=process.argv[2];try{if(cmd==='self-test')selfTest();else if(cmd==='run')await run();else throw new Error('usage: node scripts/model_benchmark_v4.mjs <self-test|run>');}catch(e){console.error(`[model-benchmark-v4] ERROR ${e.message}`);process.exit(1);}
