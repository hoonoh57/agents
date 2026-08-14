import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFirstJsonObject } from './structured_output.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TURN_SCHEMA='ResearchAgentTurn@1.0.0';
const ACTION_DECISION_SCHEMA='ResearchActionDecision@1.0.0';
const COMPLETION_DECISION_SCHEMA='ResearchCompletionDecision@1.0.0';
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

function actionDecisionSchema(){return{
  type:'object',additionalProperties:false,
  required:['schema','goalId','status','tool','featureId','period','reasoningSummary','profitabilityClaim'],
  properties:{
    schema:{type:'string',enum:[ACTION_DECISION_SCHEMA]},
    goalId:{type:'string',enum:[goal.goalId]},
    status:{type:'string',enum:['ACTION_REQUIRED']},
    tool:{type:'string',enum:['RUN_FEATURE_EXPERIMENT']},
    featureId:{type:'string',enum:registeredTool().allowedFeatureIds},
    period:{type:'integer',minimum:registeredTool().parameterContract.period.min,maximum:registeredTool().parameterContract.period.max},
    reasoningSummary:{type:'string',maxLength:1200},
    profitabilityClaim:{type:'boolean',enum:[false]}
  }
};}
function completionDecisionSchema(evidenceId){return{
  type:'object',additionalProperties:false,
  required:['schema','goalId','status','evidenceId','reasoningSummary','conclusion','nextResearch','profitabilityClaim'],
  properties:{
    schema:{type:'string',enum:[COMPLETION_DECISION_SCHEMA]},
    goalId:{type:'string',enum:[goal.goalId]},
    status:{type:'string',enum:['COMPLETE']},
    evidenceId:{type:'string',enum:[evidenceId]},
    reasoningSummary:{type:'string',maxLength:1200},
    conclusion:{type:'string',maxLength:2200},
    nextResearch:{type:'array',maxItems:2,items:{type:'string',maxLength:1000}},
    profitabilityClaim:{type:'boolean',enum:[false]}
  }
};}

function validateActionDecision(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('ACTION_DECISION object required');
  if(value.schema!==ACTION_DECISION_SCHEMA)throw new Error(`ACTION_DECISION schema actual=${String(value.schema??'missing')}`);
  if(value.goalId!==goal.goalId)throw new Error('ACTION_DECISION goalId mismatch');
  if(value.status!=='ACTION_REQUIRED')throw new Error(`ACTION_DECISION status actual=${String(value.status??'missing')}`);
  if(value.profitabilityClaim!==false)throw new Error('ACTION_DECISION profitabilityClaim must be false');
  const tool=registeredTool();
  if(value.tool!==tool.tool)throw new Error(`ACTION_DECISION tool actual=${String(value.tool??'missing')}`);
  if(!tool.allowedFeatureIds.includes(value.featureId))throw new Error(`ACTION_DECISION featureId not allowed ${String(value.featureId??'missing')}`);
  if(!Number.isInteger(value.period)||value.period<tool.parameterContract.period.min||value.period>tool.parameterContract.period.max)throw new Error(`ACTION_DECISION period invalid ${String(value.period)}`);
  if(typeof value.reasoningSummary!=='string')throw new Error('ACTION_DECISION reasoningSummary required');
  return value;
}
function validateCompletionDecision(value,evidenceId){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('COMPLETION_DECISION object required');
  if(value.schema!==COMPLETION_DECISION_SCHEMA)throw new Error(`COMPLETION_DECISION schema actual=${String(value.schema??'missing')}`);
  if(value.goalId!==goal.goalId)throw new Error('COMPLETION_DECISION goalId mismatch');
  if(value.status!=='COMPLETE')throw new Error(`COMPLETION_DECISION status actual=${String(value.status??'missing')}`);
  if(value.evidenceId!==evidenceId)throw new Error(`COMPLETION_DECISION evidenceId mismatch actual=${String(value.evidenceId??'missing')}`);
  if(value.profitabilityClaim!==false)throw new Error('COMPLETION_DECISION profitabilityClaim must be false');
  if(typeof value.reasoningSummary!=='string'||typeof value.conclusion!=='string'||!Array.isArray(value.nextResearch))throw new Error('COMPLETION_DECISION shape invalid');
  return value;
}
function validateCanonicalTurn(turn,expectedStatus){
  if(turn.schema!==TURN_SCHEMA||turn.goalId!==goal.goalId||turn.status!==expectedStatus||turn.profitabilityClaim!==false)fail(`canonical turn invalid status=${expectedStatus}`);
  if(!turnContract.status.includes(turn.status)||!Array.isArray(turn.actions)||!Array.isArray(turn.evidenceRefs))fail(`canonical turn contract invalid status=${expectedStatus}`);
  if(expectedStatus==='ACTION_REQUIRED'&&turn.actions.length!==1)fail('canonical ACTION_REQUIRED must contain one action');
  if(expectedStatus==='COMPLETE'&&(turn.actions.length!==0||turn.evidenceRefs.length!==1))fail('canonical COMPLETE envelope invalid');
  return turn;
}
function normalizeActionDecision(decision){
  const checked=validateActionDecision(decision);
  const actionId=`ACTION-${sha({goalId:goal.goalId,tool:checked.tool,featureId:checked.featureId,period:checked.period}).slice(0,16)}`;
  return validateCanonicalTurn({schema:TURN_SCHEMA,goalId:goal.goalId,status:'ACTION_REQUIRED',reasoningSummary:checked.reasoningSummary,actions:[{actionId,tool:checked.tool,arguments:{featureId:checked.featureId,parameters:{period:checked.period}}}],evidenceRefs:[],conclusion:'',nextResearch:[],profitabilityClaim:false},'ACTION_REQUIRED');
}
function normalizeCompletionDecision(decision,evidenceId){
  const checked=validateCompletionDecision(decision,evidenceId);
  return validateCanonicalTurn({schema:TURN_SCHEMA,goalId:goal.goalId,status:'COMPLETE',reasoningSummary:checked.reasoningSummary,actions:[],evidenceRefs:[evidenceId],conclusion:checked.conclusion,nextResearch:checked.nextResearch,profitabilityClaim:false},'COMPLETE');
}

if(flag('self-test')){
  const action=normalizeActionDecision({schema:ACTION_DECISION_SCHEMA,goalId:goal.goalId,status:'ACTION_REQUIRED',tool:'RUN_FEATURE_EXPERIMENT',featureId:'PRICE_MA_RECLAIM_UP',period:5,reasoningSummary:'synthetic',profitabilityClaim:false});
  if(action.actions[0].arguments.parameters.period!==5)fail('self-test action normalization failed');
  const completion=normalizeCompletionDecision({schema:COMPLETION_DECISION_SCHEMA,goalId:goal.goalId,status:'COMPLETE',evidenceId:'EVIDENCE-SELFTEST',reasoningSummary:'synthetic',conclusion:'synthetic',nextResearch:[],profitabilityClaim:false},'EVIDENCE-SELFTEST');
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
const outputTokens=Math.max(768,Number(env.LOCAL_LLM_MAX_OUTPUT_TOKENS||768));

async function callModel(messages,schema,choice){
  const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeoutSeconds*1000),body:JSON.stringify({model:choice.model,messages,format:schema,think:false,stream:false,keep_alive:'10m',options:{temperature:0,num_ctx:contextTokens,num_predict:outputTokens}})});
  const raw=await response.text();if(!response.ok)throw new Error(`OLLAMA_HTTP_${response.status}:${choice.model}: ${raw.slice(0,600)}`);let body;try{body=JSON.parse(raw);}catch{throw new Error(`OLLAMA_ENVELOPE_INVALID:${choice.model}`);}return{body,text:String(body?.message?.content||'').trim()};
}
function basePrompt(){return[
  '# AGENT',agentMd,'# DURABLE GOALS',agentGoals,'# PLAN',agentPlan,'# MEMORY INDEX',memoryIndex,
  '# SHARED OBJECTIVES',objectives,'# SHARED RULES',rules,
  '# ASSIGNED HUMAN GOAL',JSON.stringify(goal,null,2),
  '# SKILLS',...skills.flatMap(x=>[`## ${x.file}`,x.text]),
  '# TOOL REGISTRY',JSON.stringify(toolRegistry,null,2),
  '# RUNTIME BOUNDARY','You choose semantic research intent and arguments. Runtime owns actionId, actions[] envelopes, evidenceRefs[] envelopes, hashes and execution.',
  '# P0 PURPOSE','Prove the autonomous goal -> decision -> deterministic tool -> evidence -> completion loop. Strategy profitability is not the pass criterion.'
].join('\n\n');}

async function runDecision({stage,runDir,schema,validate,baseMessages,candidates}){
  let lastError='UNKNOWN_OUTPUT_ERROR';let globalAttempt=0;const diagnostics=[];
  for(let candidateIndex=0;candidateIndex<candidates.length;candidateIndex+=1){
    const choice=candidates[candidateIndex];
    if(candidateIndex>0)console.warn(`[autonomous-smoke] MODEL_ESCALATE stage=${stage} from=${candidates[candidateIndex-1].role}/${candidates[candidateIndex-1].model} to=${choice.role}/${choice.model}`);
    for(let attempt=1;attempt<=2;attempt+=1){
      globalAttempt+=1;
      const correction=globalAttempt===1?null:[`Continue the SAME goal without changing any hypothesis or evidence.`,`Previous response was invalid: ${lastError}`,'Return only the exact small JSON decision requested by the current stage. Do not return a ResearchAgentTurn envelope; runtime builds that envelope.'].join('\n');
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
const startedAt=nowIso();const primary=roleCandidates[0];
console.log(`[autonomous-smoke] START run=${runId} agent=${agent.agentId} primaryRole=${primary.role} model=${primary.model} modelSource=${primary.source} context=${contextTokens}`);

const firstRun=await runDecision({stage:'ACTION_DECISION',runDir,schema:actionDecisionSchema(),validate:validateActionDecision,candidates:roleCandidates,baseMessages:[{role:'system',content:`Return only ${ACTION_DECISION_SCHEMA} JSON. Choose semantic tool intent and arguments; runtime owns the canonical action envelope.`},{role:'user',content:[basePrompt(),'# ACTION DECISION REQUIREMENT','The assigned goal requires one deterministic research action. Return ACTION_REQUIRED with tool, featureId, and period derived from the goal and capability semantics. Do not return actionId, actions[], evidence, or a ResearchAgentTurn object.'].join('\n\n')} ]});
const firstTurn=normalizeActionDecision(firstRun.decision);writeJson(path.join(runDir,'turn-1.json'),firstTurn);
const action=firstTurn.actions[0];const checked=validateAction(action);
if(checked.featureId!=='PRICE_MA_RECLAIM_UP'||checked.period!==5)fail(`SMOKE_GOAL_MAPPING_FAILED feature=${checked.featureId} period=${checked.period}`);
console.log(`[autonomous-smoke] ACTION role=${firstRun.role} tool=${action.tool} feature=${checked.featureId} period=${checked.period}`);

const evidence=executeAction(action,runDir);console.log(`[autonomous-smoke] TOOL_PASS evidence=${evidence.evidenceId} events=${evidence.evidence.eventCount}`);
const secondCandidates=uniqueRoleCandidates([firstRun.role,'LOCAL_REASONER']);
const secondRun=await runDecision({stage:'COMPLETION_DECISION',runDir,schema:completionDecisionSchema(evidence.evidenceId),validate:value=>validateCompletionDecision(value,evidence.evidenceId),candidates:secondCandidates,baseMessages:[{role:'system',content:`Return only ${COMPLETION_DECISION_SCHEMA} JSON. Read the supplied tool evidence and conclude the same goal.`},{role:'user',content:[basePrompt(),'# CANONICAL PRIOR TURN',JSON.stringify(firstTurn,null,2),'# TOOL EVIDENCE',JSON.stringify(evidence,null,2),'# COMPLETION DECISION REQUIREMENT',`Return COMPLETE with evidenceId exactly "${evidence.evidenceId}". Summarize what the evidence says and limitations. Do not request another action and do not return a ResearchAgentTurn envelope.`].join('\n\n')} ]});
const finalTurn=normalizeCompletionDecision(secondRun.decision,evidence.evidenceId);writeJson(path.join(runDir,'turn-2.json'),finalTurn);

const completedAt=nowIso();const result={schema:RESULT_SCHEMA,status:'PASS',runId,goalId:goal.goalId,agentId:agent.agentId,primaryModelRole:primaryRole,primaryModel:primary.model,startedAt,completedAt,inputHashes,modelExecution:{firstTurn:{role:firstRun.role,model:firstRun.model,modelSource:firstRun.modelSource,escalated:firstRun.escalated},secondTurn:{role:secondRun.role,model:secondRun.model,modelSource:secondRun.modelSource,escalated:secondRun.escalated}},outputRecovery:{firstTurnAttempts:firstRun.attempts,secondTurnAttempts:secondRun.attempts},decisionSchemas:{action:ACTION_DECISION_SCHEMA,completion:COMPLETION_DECISION_SCHEMA,canonicalTurn:TURN_SCHEMA},firstDecision:firstRun.decision,firstTurn,toolEvidence:evidence,completionDecision:secondRun.decision,finalTurn,checks:{goalRead:true,workspaceContextRead:true,skillRead:true,modelResolvedFromContract:true,minimalModelDecision:true,runtimeTurnNormalization:true,structuredOutputRecovery:true,automaticModelEscalation:true,correctCapabilitySelected:true,whitelistedToolExecuted:true,evidenceReturnedToSameAgent:true,completeReturned:true,profitabilityClaim:false},profitabilityClaim:false};
const resultPath=path.join(runDir,'result.json');writeJson(resultPath,result);
console.log(`[autonomous-smoke] COMPLETE run=${runId} status=PASS firstRole=${firstRun.role} firstAttempts=${firstRun.attempts} secondRole=${secondRun.role} secondAttempts=${secondRun.attempts}`);console.log(`[autonomous-smoke] RESULT_PATH=${resultPath}`);
