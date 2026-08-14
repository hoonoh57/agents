import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFirstJsonObject } from './structured_output.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TURN_SCHEMA='ResearchAgentTurn@1.0.0';
const RESULT_SCHEMA='AutonomousResearchSmokeResult@1.0.0';

function fail(message){throw new Error(`[autonomous-smoke] ${message}`);}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function readText(file){return fs.readFileSync(file,'utf8');}
function readEnv(file){const out={};if(!fs.existsSync(file))return out;for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const i=line.indexOf('=');if(i<0)continue;out[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');}return out;}
function nowIso(){return new Date().toISOString();}
function sha(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n','utf8');}
function flag(name){return process.argv.includes(`--${name}`);}

const env={...readEnv(path.join(root,'.env')),...process.env};
const goalPath=path.join(root,'goals','GOAL-AUTONOMOUS-MA5-SMOKE-001.json');
const goal=readJson(goalPath);
const registry=readJson(path.join(root,'registry','agents.json'));
const agent=registry.agents.find(x=>x.agentId===goal.agentId&&x.enabled);if(!agent)fail(`agent unavailable ${goal.agentId}`);
const modelRegistryPath=path.join(root,'registry','models.json');
const modelRegistry=readJson(modelRegistryPath);
const toolRegistryPath=path.join(root,'registry','research_tools.json');
const turnContractPath=path.join(root,'registry','research_agent_turn_schema.json');
const toolRegistry=readJson(toolRegistryPath);
const turnContract=readJson(turnContractPath);
const skillFiles=['skills/research-loop/SKILL.md','skills/profit-feature-explorer/SKILL.md','skills/research-tools/SKILL.md'];
const skills=skillFiles.map(file=>({file,text:readText(path.join(root,file))}));
const agentRoot=path.join(root,'agents',agent.agentId);
const agentMd=readText(path.join(agentRoot,'AGENT.md'));
const agentGoals=readText(path.join(agentRoot,'GOALS.md'));
const agentPlan=readText(path.join(agentRoot,'PLAN.md'));
const memoryIndex=readText(path.join(agentRoot,'MEMORY_INDEX.md'));
const objectives=readText(path.join(root,'shared','OBJECTIVES.md'));
const rules=readText(path.join(root,'shared','RESEARCH_RULES.md'));
const inputHashes={goalSha256:sha(readText(goalPath)),agentSha256:sha(agentMd),goalsSha256:sha(agentGoals),planSha256:sha(agentPlan),memoryIndexSha256:sha(memoryIndex),modelRegistrySha256:sha(readText(modelRegistryPath)),toolRegistrySha256:sha(readText(toolRegistryPath)),turnContractSha256:sha(readText(turnContractPath)),skills:Object.fromEntries(skills.map(x=>[x.file,sha(x.text)]))};

function modelForRole(role){
  const envKey=role==='LOCAL_FAST'?'LOCAL_LLM_FAST_MODEL':role==='LOCAL_CODER'?'LOCAL_LLM_CODER_MODEL':'LOCAL_LLM_REASONER_MODEL';
  const configured=String(env[envKey]||'').trim();
  if(configured)return{role,model:configured,source:'ENV'};
  const selected=String(modelRegistry.roles?.find(x=>x.role===role)?.selectedModel||'').trim();
  if(selected)return{role,model:selected,source:'REGISTRY'};
  return{role,model:'',source:'NONE'};
}
function uniqueRoleCandidates(roles){const seen=new Set();return roles.filter(role=>{if(!role||seen.has(role))return false;seen.add(role);return true;}).map(modelForRole).filter(x=>x.model);}
function registeredTool(){const tool=toolRegistry.tools.find(x=>x.enabled&&x.tool==='RUN_FEATURE_EXPERIMENT');if(!tool)fail('RUN_FEATURE_EXPERIMENT is not enabled');if(tool.readOnly!==true||tool.brokerAction!==false)fail('research tool must be read-only and non-broker');return tool;}

function actionSemanticSchema(){const tool=registeredTool();return{
  type:'object',additionalProperties:false,
  required:['tool','featureId','period','reasoningSummary'],
  properties:{
    tool:{type:'string',enum:[tool.tool]},
    featureId:{type:'string',enum:tool.allowedFeatureIds},
    period:{type:'integer',minimum:tool.parameterContract.period.min,maximum:tool.parameterContract.period.max},
    reasoningSummary:{type:'string',maxLength:1200}
  }
};}
function completionSemanticSchema(evidenceId,evidence){const d=evidence.evidence;return{
  type:'object',additionalProperties:false,
  required:['evidenceId','observedEventCount','observedDiscoverySampleCount','observedValidationSampleCount','reasoningSummary','conclusion','nextResearch'],
  properties:{
    evidenceId:{type:'string',enum:[evidenceId]},
    observedEventCount:{type:'integer',enum:[Number(d.eventCount)]},
    observedDiscoverySampleCount:{type:'integer',enum:[Number(d.discovery?.sampleCount??0)]},
    observedValidationSampleCount:{type:'integer',enum:[Number(d.validation?.sampleCount??0)]},
    reasoningSummary:{type:'string',maxLength:1200},
    conclusion:{type:'string',maxLength:2200},
    nextResearch:{type:'array',maxItems:2,items:{type:'string',maxLength:1000}}
  }
};}
function validateActionSemantic(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('ACTION semantic object required');
  const tool=registeredTool();
  if(value.tool!==tool.tool)throw new Error(`ACTION tool actual=${String(value.tool??'missing')}`);
  if(!tool.allowedFeatureIds.includes(value.featureId))throw new Error(`ACTION featureId not allowed ${String(value.featureId??'missing')}`);
  if(!Number.isInteger(value.period)||value.period<tool.parameterContract.period.min||value.period>tool.parameterContract.period.max)throw new Error(`ACTION period invalid ${String(value.period)}`);
  if(typeof value.reasoningSummary!=='string'||!value.reasoningSummary.trim())throw new Error('ACTION reasoningSummary required');
  return value;
}
function normalizeActionSemantic(decision){
  const checked=validateActionSemantic(decision);
  const actionId=`ACTION-${sha({goalId:goal.goalId,tool:checked.tool,featureId:checked.featureId,period:checked.period}).slice(0,16)}`;
  const turn={schema:TURN_SCHEMA,goalId:goal.goalId,status:'ACTION_REQUIRED',reasoningSummary:checked.reasoningSummary,actions:[{actionId,tool:checked.tool,arguments:{featureId:checked.featureId,parameters:{period:checked.period}}}],evidenceRefs:[],conclusion:'',nextResearch:[],profitabilityClaim:false};
  return validateCanonicalTurn(turn,'ACTION_REQUIRED');
}
function validateCompletionSemantic(value,evidenceId,evidence){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('COMPLETION semantic object required');
  const d=evidence.evidence;
  if(value.evidenceId!==evidenceId)throw new Error(`COMPLETION evidenceId mismatch actual=${String(value.evidenceId??'missing')}`);
  if(Number(value.observedEventCount)!==Number(d.eventCount))throw new Error(`COMPLETION eventCount mismatch actual=${String(value.observedEventCount??'missing')}`);
  if(Number(value.observedDiscoverySampleCount)!==Number(d.discovery?.sampleCount??0))throw new Error(`COMPLETION discovery sample mismatch actual=${String(value.observedDiscoverySampleCount??'missing')}`);
  if(Number(value.observedValidationSampleCount)!==Number(d.validation?.sampleCount??0))throw new Error(`COMPLETION validation sample mismatch actual=${String(value.observedValidationSampleCount??'missing')}`);
  if(typeof value.reasoningSummary!=='string'||!value.reasoningSummary.trim())throw new Error('COMPLETION reasoningSummary required');
  if(typeof value.conclusion!=='string'||!value.conclusion.trim())throw new Error('COMPLETION conclusion required');
  if(!Array.isArray(value.nextResearch))throw new Error('COMPLETION nextResearch required');
  return value;
}
function normalizeCompletionSemantic(decision,evidenceId,evidence){
  const checked=validateCompletionSemantic(decision,evidenceId,evidence);
  const turn={
    schema:TURN_SCHEMA,goalId:goal.goalId,status:'COMPLETE',reasoningSummary:checked.reasoningSummary,
    actions:[],evidenceRefs:[evidenceId],conclusion:checked.conclusion,nextResearch:checked.nextResearch,profitabilityClaim:false
  };
  return validateCanonicalTurn(turn,'COMPLETE');
}
function validateCanonicalTurn(turn,expectedStatus){
  if(turn.schema!==TURN_SCHEMA||turn.goalId!==goal.goalId||turn.status!==expectedStatus||turn.profitabilityClaim!==false)fail(`canonical turn invalid status=${expectedStatus}`);
  if(!turnContract.status.includes(turn.status)||!Array.isArray(turn.actions)||!Array.isArray(turn.evidenceRefs))fail(`canonical turn contract invalid status=${expectedStatus}`);
  if(expectedStatus==='ACTION_REQUIRED'&&turn.actions.length!==1)fail('canonical ACTION_REQUIRED must contain one action');
  if(expectedStatus==='COMPLETE'&&(turn.actions.length!==0||turn.evidenceRefs.length!==1))fail('canonical COMPLETE envelope invalid');
  return turn;
}

if(flag('self-test')){
  const action=normalizeActionSemantic({tool:'RUN_FEATURE_EXPERIMENT',featureId:'PRICE_MA_RECLAIM_UP',period:5,reasoningSummary:'synthetic'});
  if(action.actions[0].arguments.parameters.period!==5)fail('self-test action normalization failed');
  const syntheticEvidence={evidenceId:'EVIDENCE-SELFTEST',evidence:{eventCount:12,discovery:{sampleCount:8},validation:{sampleCount:4}}};
  const completion=normalizeCompletionSemantic({evidenceId:'EVIDENCE-SELFTEST',observedEventCount:12,observedDiscoverySampleCount:8,observedValidationSampleCount:4,reasoningSummary:'synthetic',conclusion:'synthetic',nextResearch:[]},'EVIDENCE-SELFTEST',syntheticEvidence);
  if(completion.evidenceRefs[0]!=='EVIDENCE-SELFTEST')fail('self-test completion normalization failed');
  console.log('AUTONOMOUS_SMOKE_SELF_TEST_PASS');
  process.exit(0);
}

const primaryRole=agent.modelRoleHint||'LOCAL_REASONER';
const roleCandidates=uniqueRoleCandidates([primaryRole,'LOCAL_REASONER']);
if(!roleCandidates.length)fail(`MODEL_NOT_CONFIGURED:${primaryRole}`);
const base=(env.LOCAL_LLM_BASE_URL||'http://127.0.0.1:11434').replace(/\/$/,'');
const timeoutSeconds=Math.max(30,Number(env.LOCAL_LLM_TIMEOUT_SECONDS||120));
const contextTokens=Math.max(8192,Number(env.LOCAL_LLM_CONTEXT_TOKENS||8192));
const outputTokens=Math.max(512,Number(env.LOCAL_LLM_MAX_OUTPUT_TOKENS||768));

async function callModel(messages,schema,choice){
  const response=await fetch(`${base}/api/chat`,{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeoutSeconds*1000),
    body:JSON.stringify({model:choice.model,messages,format:schema,think:false,stream:false,keep_alive:0,options:{temperature:0,num_ctx:contextTokens,num_predict:outputTokens}})
  });
  const raw=await response.text();
  if(!response.ok)throw new Error(`OLLAMA_HTTP_${response.status}:${choice.model}: ${raw.slice(0,600)}`);
  let body;try{body=JSON.parse(raw);}catch{throw new Error(`OLLAMA_ENVELOPE_INVALID:${choice.model}`);}
  return{body,text:String(body?.message?.content||'').trim()};
}
function basePrompt(){return[
  '# AGENT',agentMd,'# DURABLE GOALS',agentGoals,'# PLAN',agentPlan,'# MEMORY INDEX',memoryIndex,
  '# SHARED OBJECTIVES',objectives,'# SHARED RULES',rules,
  '# ASSIGNED HUMAN GOAL',JSON.stringify(goal,null,2),
  '# SKILLS',...skills.flatMap(x=>[`## ${x.file}`,x.text]),
  '# TOOL REGISTRY',JSON.stringify(toolRegistry,null,2),
  '# RUNTIME BOUNDARY','You choose only semantic research intent, tool arguments, evidence interpretation, conclusion and next research. Runtime owns schema ids, goal/status envelopes, action ids, evidenceRefs, hashes, timestamps and execution.',
  '# P0 PURPOSE','Prove the autonomous goal -> semantic decision -> deterministic tool -> evidence -> semantic completion -> canonical COMPLETE loop. Strategy profitability is not the pass criterion.'
].join('\n\n');}

async function runDecision({stage,runDir,schema,validate,baseMessages,candidates}){
  let lastError='UNKNOWN_OUTPUT_ERROR';let globalAttempt=0;const diagnostics=[];
  for(let candidateIndex=0;candidateIndex<candidates.length;candidateIndex+=1){
    const choice=candidates[candidateIndex];
    if(candidateIndex>0)console.warn(`[autonomous-smoke] MODEL_ESCALATE stage=${stage} from=${candidates[candidateIndex-1].role}/${candidates[candidateIndex-1].model} to=${choice.role}/${choice.model}`);
    for(let attempt=1;attempt<=2;attempt+=1){
      globalAttempt+=1;
      const correction=globalAttempt===1?null:[`Continue the SAME goal without changing any hypothesis or evidence.`,`Previous response was invalid: ${lastError}`,'Return only the exact small JSON semantic decision requested by the current stage. Runtime owns all system envelopes.'].join('\n');
      const messages=correction?[...baseMessages,{role:'user',content:correction}]:baseMessages;
      let call=null,parsed={value:null,error:null,strict:null,recovered:null,trailing:null},decision=null,error=null;
      try{call=await callModel(messages,schema,choice);parsed=parseFirstJsonObject(call.text);if(!parsed.value)error=`JSON_PARSE_FAILED:${parsed.error||'unknown'}`;else{try{decision=validate(parsed.value);}catch(e){error=String(e?.message||e);}}}catch(e){error=String(e?.message||e);}
      const diag={stage,globalAttempt,role:choice.role,attempt,model:choice.model,modelSource:choice.source,doneReason:call?.body?.done_reason??null,rawText:call?.text??null,parsedSchema:parsed.value?.schema??null,parsedStatus:parsed.value?.status??null,parseStrict:parsed.strict??null,parseRecovered:parsed.recovered??null,parseTrailing:parsed.trailing??null,error};
      diagnostics.push(diag);writeJson(path.join(runDir,`${stage.toLowerCase()}-${choice.role.toLowerCase()}-attempt-${attempt}.json`),diag);
      if(decision){if(globalAttempt>1)console.log(`[autonomous-smoke] OUTPUT_RECOVERED stage=${stage} role=${choice.role} attempt=${attempt} globalAttempt=${globalAttempt}`);return{decision,attempts:globalAttempt,diagnostics,role:choice.role,model:choice.model,modelSource:choice.source,escalated:candidateIndex>0};}
      lastError=error||'OUTPUT_INVALID';console.warn(`[autonomous-smoke] OUTPUT_INVALID stage=${stage} role=${choice.role} attempt=${attempt}/2 error=${lastError}`);
    }
  }
  fail(`${stage} OUTPUT_INVALID_AFTER_ESCALATION lastError=${lastError}`);
}

function validateAction(action){
  const tool=registeredTool();if(action.tool!==tool.tool)fail(`tool not whitelisted ${action.tool}`);
  const featureId=String(action.arguments?.featureId||'');const period=Number(action.arguments?.parameters?.period);
  if(!tool.allowedFeatureIds.includes(featureId))fail(`feature not allowed ${featureId}`);
  if(!Number.isInteger(period)||period<tool.parameterContract.period.min||period>tool.parameterContract.period.max)fail(`period out of contract ${period}`);
  return{tool,featureId,period};
}
function executeAction(action,runDir){
  const checked=validateAction(action);const researchRoot=env.RESEARCH_LOCAL_ROOT;if(!researchRoot)fail('RESEARCH_LOCAL_ROOT is required');
  const executor=path.join(researchRoot,'scripts','run_feature_experiment_tool.mjs');if(!fs.existsSync(executor))fail(`research tool executor missing ${executor}`);
  const datasetHash=goal.toolContext?.datasetHash;const snapshotExperiment=goal.toolContext?.snapshotExperiment;
  const args=[executor,'--feature',checked.featureId,'--period',String(checked.period),'--dataset',datasetHash,'--snapshot-experiment',snapshotExperiment];
  const child=spawnSync(process.execPath,args,{cwd:researchRoot,encoding:'utf8',windowsHide:true,timeout:120000});if(child.error)fail(`tool spawn failed ${child.error.message}`);if(child.status!==0)fail(`tool exit=${child.status} stderr=${String(child.stderr||'').slice(0,800)}`);
  let evidence;try{evidence=JSON.parse(String(child.stdout||'').trim());}catch{fail(`tool returned invalid JSON: ${String(child.stdout||'').slice(0,800)}`);}if(evidence.schema!=='ResearchToolEvidence@1.0.0'||evidence.profitabilityClaim!==false)fail('tool evidence schema invalid');
  const evidenceId=`EVIDENCE-${sha(evidence).slice(0,16)}`;const wrapped={evidenceId,actionId:action.actionId,createdAt:nowIso(),evidence};writeJson(path.join(runDir,`${evidenceId}.json`),wrapped);return wrapped;
}

const runId=`AUTO-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}-${crypto.randomBytes(3).toString('hex')}`;
const runDir=path.join(root,'runtime','autonomous-smoke',runId);fs.mkdirSync(runDir,{recursive:true});
const startedAt=nowIso();
const primary=roleCandidates[0];
console.log(`[autonomous-smoke] START run=${runId} agent=${agent.agentId} primaryRole=${primary.role} model=${primary.model} modelSource=${primary.source} context=${contextTokens}`);

const actionRun=await runDecision({stage:'ACTION_DECISION',runDir,schema:actionSemanticSchema(),validate:validateActionSemantic,candidates:roleCandidates,baseMessages:[{role:'system',content:'You are an evidence-bound local research agent. Return only the requested small JSON semantic decision. Runtime owns all system envelopes.'},{role:'user',content:[basePrompt(),'# ACTION DECISION','Read the human goal and available capabilities. Choose the minimum existing deterministic research action needed to answer the goal. Return only tool, featureId, period and a short reasoningSummary.'].join('\n\n')}]});
const semanticAction=actionRun.decision;
const firstTurn=normalizeActionSemantic(semanticAction);writeJson(path.join(runDir,'turn-1.json'),firstTurn);
const action=firstTurn.actions[0];const checked=validateAction(action);
if(checked.featureId!=='PRICE_MA_RECLAIM_UP'||checked.period!==5)fail(`SMOKE_GOAL_MAPPING_FAILED feature=${checked.featureId} period=${checked.period}`);
console.log(`[autonomous-smoke] ACTION role=${actionRun.role} tool=${action.tool} feature=${checked.featureId} period=${checked.period}`);

const evidence=executeAction(action,runDir);console.log(`[autonomous-smoke] TOOL_PASS evidence=${evidence.evidenceId} events=${evidence.evidence.eventCount}`);
const completionPrompt=[basePrompt(),'# PRIOR CANONICAL TURN',JSON.stringify(firstTurn,null,2),'# TOOL EVIDENCE',JSON.stringify(evidence,null,2),'# COMPLETION DECISION','Read the evidence. Return only the exact evidence id, observed event/discovery/validation counts, a short evidence-bound reasoning summary, conclusion, and up to two nextResearch items. Runtime will build COMPLETE and evidenceRefs.'].join('\n\n');
const completionCandidates=uniqueRoleCandidates([actionRun.role,'LOCAL_REASONER']);
const completionRun=await runDecision({stage:'COMPLETION_DECISION',runDir,schema:completionSemanticSchema(evidence.evidenceId,evidence),validate:value=>validateCompletionSemantic(value,evidence.evidenceId,evidence),candidates:completionCandidates,baseMessages:[{role:'system',content:'You are the same evidence-bound local research agent. Read the supplied tool evidence and return only the requested semantic completion JSON.'},{role:'user',content:completionPrompt}]});
const semanticCompletion=completionRun.decision;
const finalTurn=normalizeCompletionSemantic(semanticCompletion,evidence.evidenceId,evidence);writeJson(path.join(runDir,'turn-2.json'),finalTurn);

const completedAt=nowIso();const result={schema:RESULT_SCHEMA,status:'PASS',runId,goalId:goal.goalId,agentId:agent.agentId,primaryModelRole:primaryRole,primaryModel:primary.model,startedAt,completedAt,inputHashes,modelExecution:{actionDecision:{role:actionRun.role,model:actionRun.model,modelSource:actionRun.modelSource,escalated:actionRun.escalated,attempts:actionRun.attempts},completionDecision:{role:completionRun.role,model:completionRun.model,modelSource:completionRun.modelSource,escalated:completionRun.escalated,attempts:completionRun.attempts}},semanticActionDecision:semanticAction,firstTurn,toolEvidence:evidence,semanticCompletionDecision:semanticCompletion,finalTurn,checks:{goalRead:true,workspaceContextRead:true,skillRead:true,correctCapabilitySelected:true,whitelistedToolExecuted:true,evidenceReturnedToSameAgent:true,evidenceIdRead:true,eventCountRead:true,discoverySampleCountRead:true,validationSampleCountRead:true,canonicalTurnNormalization:true,completeReturned:true,profitabilityClaim:false},profitabilityClaim:false};
const resultPath=path.join(runDir,'result.json');writeJson(resultPath,result);
console.log(`[autonomous-smoke] COMPLETE run=${runId} status=PASS actionRole=${actionRun.role} actionAttempts=${actionRun.attempts} completionRole=${completionRun.role} completionAttempts=${completionRun.attempts}`);console.log(`[autonomous-smoke] RESULT_PATH=${resultPath}`);
