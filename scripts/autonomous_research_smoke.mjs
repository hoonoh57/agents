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
  if(configured)return{model:configured,source:'ENV'};
  const selected=String(modelRegistry.roles?.find(x=>x.role===role)?.selectedModel||'').trim();
  if(selected)return{model:selected,source:'REGISTRY'};
  return{model:'',source:'NONE'};
}
const role=agent.modelRoleHint||'LOCAL_REASONER';const modelResolution=modelForRole(role);const model=modelResolution.model;if(!model)fail(`MODEL_NOT_CONFIGURED:${role}`);
const base=(env.LOCAL_LLM_BASE_URL||'http://127.0.0.1:11434').replace(/\/$/,'');
const timeoutSeconds=Math.max(30,Number(env.LOCAL_LLM_TIMEOUT_SECONDS||120));
const contextTokens=Math.max(4096,Number(env.LOCAL_LLM_CONTEXT_TOKENS||16384));
const outputTokens=Math.max(768,Number(env.LOCAL_LLM_MAX_OUTPUT_TOKENS||1024));

function actionSchema(minItems,maxItems){return{type:'array',minItems,maxItems,items:{type:'object',additionalProperties:false,required:['actionId','tool','arguments'],properties:{actionId:{type:'string'},tool:{type:'string',enum:['RUN_FEATURE_EXPERIMENT']},arguments:{type:'object',additionalProperties:false,required:['featureId','parameters'],properties:{featureId:{type:'string'},parameters:{type:'object',additionalProperties:false,required:['period'],properties:{period:{type:'integer',minimum:2,maximum:240}}}}}}}};}
function turnJsonSchema(expectedStatus){return{
  type:'object',additionalProperties:false,
  required:['schema','goalId','status','reasoningSummary','actions','evidenceRefs','conclusion','nextResearch','profitabilityClaim'],
  properties:{
    schema:{type:'string',enum:[TURN_SCHEMA]},goalId:{type:'string',enum:[goal.goalId]},status:{type:'string',enum:[expectedStatus]},reasoningSummary:{type:'string',maxLength:1800},
    actions:actionSchema(expectedStatus==='ACTION_REQUIRED'?1:0,expectedStatus==='ACTION_REQUIRED'?1:0),
    evidenceRefs:{type:'array',maxItems:8,items:{type:'string'}},conclusion:{type:'string',maxLength:2200},nextResearch:{type:'array',maxItems:2,items:{type:'string',maxLength:1000}},profitabilityClaim:{type:'boolean',enum:[false]}
  }
};}

function validateTurnValue(turn,stage,expectedStatus,requiredEvidenceId=null){
  if(!turn||typeof turn!=='object'||Array.isArray(turn))throw new Error(`${stage}: JSON object required`);
  if(turn.schema!==TURN_SCHEMA)throw new Error(`${stage}: schema expected=${TURN_SCHEMA} actual=${String(turn.schema??'missing')}`);
  if(turn.goalId!==goal.goalId)throw new Error(`${stage}: goalId mismatch actual=${String(turn.goalId??'missing')}`);
  if(turn.status!==expectedStatus)throw new Error(`${stage}: status expected=${expectedStatus} actual=${String(turn.status??'missing')}`);
  if(turn.profitabilityClaim!==false)throw new Error(`${stage}: profitabilityClaim must be false`);
  if(!turnContract.status.includes(turn.status))throw new Error(`${stage}: invalid status ${turn.status}`);
  if(!Array.isArray(turn.actions))throw new Error(`${stage}: actions required`);
  if(expectedStatus==='ACTION_REQUIRED'&&turn.actions.length!==1)throw new Error(`${stage}: ACTION_REQUIRED needs one action`);
  if(expectedStatus==='COMPLETE'&&turn.actions.length!==0)throw new Error(`${stage}: COMPLETE must have zero actions`);
  if(!Array.isArray(turn.evidenceRefs))throw new Error(`${stage}: evidenceRefs required`);
  if(typeof turn.conclusion!=='string')throw new Error(`${stage}: conclusion must be string`);
  if(expectedStatus==='COMPLETE'&&requiredEvidenceId&&!turn.evidenceRefs.includes(requiredEvidenceId))throw new Error(`${stage}: COMPLETE must cite ${requiredEvidenceId}`);
  return turn;
}

async function callModel(messages,expectedStatus){
  const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeoutSeconds*1000),body:JSON.stringify({model,messages,format:turnJsonSchema(expectedStatus),think:false,stream:false,keep_alive:'10m',options:{temperature:0,num_ctx:contextTokens,num_predict:outputTokens}})});
  const raw=await response.text();if(!response.ok)fail(`OLLAMA_HTTP_${response.status}: ${raw.slice(0,600)}`);let body;try{body=JSON.parse(raw);}catch{fail('Ollama returned non-JSON envelope');}return{body,text:String(body?.message?.content||'').trim()};
}

function basePrompt(){return[
  '# AGENT',agentMd,'# DURABLE GOALS',agentGoals,'# PLAN',agentPlan,'# MEMORY INDEX',memoryIndex,
  '# SHARED OBJECTIVES',objectives,'# SHARED RULES',rules,
  '# ASSIGNED HUMAN GOAL',JSON.stringify(goal,null,2),
  '# SKILLS',...skills.flatMap(x=>[`## ${x.file}`,x.text]),
  '# TOOL REGISTRY',JSON.stringify(toolRegistry,null,2),
  '# TURN CONTRACT',JSON.stringify(turnContract,null,2),
  '# RESPONSE','Return only one ResearchAgentTurn@1.0.0 JSON object. Do not invent tool evidence. The purpose is to prove the autonomous loop; strategy profitability is not the pass criterion.'
].join('\n\n');}

function validateAction(action){
  const tool=toolRegistry.tools.find(x=>x.enabled&&x.tool===action.tool);if(!tool)fail(`tool not whitelisted ${action.tool}`);if(tool.brokerAction!==false||tool.readOnly!==true)fail('P0 tool must be read-only non-broker');
  const featureId=String(action.arguments?.featureId||'');const period=Number(action.arguments?.parameters?.period);if(!tool.allowedFeatureIds.includes(featureId))fail(`feature not allowed ${featureId}`);if(!Number.isInteger(period)||period<tool.parameterContract.period.min||period>tool.parameterContract.period.max)fail(`period out of contract ${period}`);
  return{tool,featureId,period};
}

function executeAction(action,runDir){
  const checked=validateAction(action);
  const researchRoot=env.RESEARCH_LOCAL_ROOT;if(!researchRoot)fail('RESEARCH_LOCAL_ROOT is required');
  const executor=path.join(researchRoot,'scripts','run_feature_experiment_tool.mjs');if(!fs.existsSync(executor))fail(`research tool executor missing ${executor}`);
  const datasetHash=goal.toolContext?.datasetHash;const snapshotExperiment=goal.toolContext?.snapshotExperiment;
  const args=[executor,'--feature',checked.featureId,'--period',String(checked.period),'--dataset',datasetHash,'--snapshot-experiment',snapshotExperiment];
  const child=spawnSync(process.execPath,args,{cwd:researchRoot,encoding:'utf8',windowsHide:true,timeout:120000});if(child.error)fail(`tool spawn failed ${child.error.message}`);if(child.status!==0)fail(`tool exit=${child.status} stderr=${String(child.stderr||'').slice(0,800)}`);
  let evidence;try{evidence=JSON.parse(String(child.stdout||'').trim());}catch{fail(`tool returned invalid JSON: ${String(child.stdout||'').slice(0,800)}`);}if(evidence.schema!=='ResearchToolEvidence@1.0.0'||evidence.profitabilityClaim!==false)fail('tool evidence schema invalid');
  const evidenceId=`EVIDENCE-${sha(evidence).slice(0,16)}`;const wrapped={evidenceId,actionId:action.actionId,createdAt:nowIso(),evidence};writeJson(path.join(runDir,`${evidenceId}.json`),wrapped);return wrapped;
}

async function runTurn({stage,expectedStatus,runDir,baseMessages,requiredEvidenceId=null}){
  const diagnostics=[];
  let lastError='UNKNOWN_OUTPUT_ERROR';
  for(let attempt=1;attempt<=2;attempt+=1){
    const messages=attempt===1?baseMessages:[...baseMessages,{role:'user',content:[
      `Your previous response was invalid: ${lastError}`,
      `Retry the SAME goal without changing the hypothesis or evidence.`,
      `Return exactly one JSON object with schema="${TURN_SCHEMA}", goalId="${goal.goalId}", status="${expectedStatus}", profitabilityClaim=false.`,
      expectedStatus==='ACTION_REQUIRED'?'Request exactly one whitelisted action and no evidence refs are required yet.':`Request zero actions and cite evidenceRefs including "${requiredEvidenceId}".`,
      'Do not add markdown or prose outside the JSON object.'
    ].join('\n')}];
    const call=await callModel(messages,expectedStatus);
    const parsed=parseFirstJsonObject(call.text);
    let turn=null,error=null;
    if(!parsed.value)error=`JSON_PARSE_FAILED:${parsed.error||'unknown'}`;
    else{try{turn=validateTurnValue(parsed.value,stage,expectedStatus,requiredEvidenceId);}catch(e){error=String(e?.message||e);}}
    const diag={stage,attempt,model,modelSource:modelResolution.source,doneReason:call.body?.done_reason??null,rawText:call.text,parsedSchema:parsed.value?.schema??null,parsedGoalId:parsed.value?.goalId??null,parsedStatus:parsed.value?.status??null,parseStrict:parsed.strict??null,parseRecovered:parsed.recovered??null,parseTrailing:parsed.trailing??null,error};
    diagnostics.push(diag);writeJson(path.join(runDir,`${stage.toLowerCase()}-attempt-${attempt}.json`),diag);
    if(turn){if(attempt>1)console.log(`[autonomous-smoke] OUTPUT_RECOVERED stage=${stage} attempt=${attempt}`);return{turn,attempts:attempt,diagnostics};}
    lastError=error||'OUTPUT_INVALID';console.warn(`[autonomous-smoke] OUTPUT_INVALID stage=${stage} attempt=${attempt}/2 error=${lastError}`);
  }
  fail(`${stage} OUTPUT_INVALID_AFTER_RETRY lastError=${lastError}`);
}

const runId=`AUTO-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}-${crypto.randomBytes(3).toString('hex')}`;
const runDir=path.join(root,'runtime','autonomous-smoke',runId);fs.mkdirSync(runDir,{recursive:true});
const startedAt=nowIso();
console.log(`[autonomous-smoke] START run=${runId} agent=${agent.agentId} role=${role} model=${model} modelSource=${modelResolution.source}`);

const firstRun=await runTurn({stage:'FIRST_TURN',expectedStatus:'ACTION_REQUIRED',runDir,baseMessages:[{role:'system',content:`You are an evidence-bound autonomous local research agent. Return only ${TURN_SCHEMA} JSON. Use only whitelisted research tools.`},{role:'user',content:[basePrompt(),'# FIRST TURN REQUIREMENT','Read the goal and capabilities. If analysis requires the deterministic tool, return ACTION_REQUIRED with exactly one action. Do not invent evidence.'].join('\n\n')}]});
const firstTurn=firstRun.turn;writeJson(path.join(runDir,'turn-1.json'),firstTurn);
const action=firstTurn.actions[0];const checked=validateAction(action);
if(checked.featureId!=='PRICE_MA_RECLAIM_UP'||checked.period!==5)fail(`SMOKE_GOAL_MAPPING_FAILED feature=${checked.featureId} period=${checked.period}`);
console.log(`[autonomous-smoke] ACTION tool=${action.tool} feature=${checked.featureId} period=${checked.period}`);

const evidence=executeAction(action,runDir);console.log(`[autonomous-smoke] TOOL_PASS evidence=${evidence.evidenceId} events=${evidence.evidence.eventCount}`);
const secondPrompt=[basePrompt(),'# PRIOR AGENT TURN',JSON.stringify(firstTurn,null,2),'# TOOL EVIDENCE',JSON.stringify(evidence,null,2),'# SECOND TURN REQUIREMENT',`The requested deterministic action has completed. Return COMPLETE with zero actions and evidenceRefs including "${evidence.evidenceId}". Summarize what the evidence says and its limitations. Do not request another action.`].join('\n\n');
const secondRun=await runTurn({stage:'SECOND_TURN',expectedStatus:'COMPLETE',runDir,requiredEvidenceId:evidence.evidenceId,baseMessages:[{role:'system',content:`You are the same evidence-bound autonomous local research agent continuing the prior task. Return only ${TURN_SCHEMA} JSON.`},{role:'user',content:secondPrompt}]});
const finalTurn=secondRun.turn;writeJson(path.join(runDir,'turn-2.json'),finalTurn);

const completedAt=nowIso();const result={schema:RESULT_SCHEMA,status:'PASS',runId,goalId:goal.goalId,agentId:agent.agentId,modelRole:role,modelVersion:model,modelSource:modelResolution.source,startedAt,completedAt,inputHashes,outputRecovery:{firstTurnAttempts:firstRun.attempts,secondTurnAttempts:secondRun.attempts},firstTurn,toolEvidence:evidence,finalTurn,checks:{goalRead:true,workspaceContextRead:true,skillRead:true,modelResolvedFromContract:true,structuredOutputRecovery:true,correctCapabilitySelected:true,whitelistedToolExecuted:true,evidenceReturnedToSameAgent:true,completeReturned:true,profitabilityClaim:false},profitabilityClaim:false};
const resultPath=path.join(runDir,'result.json');writeJson(resultPath,result);
console.log(`[autonomous-smoke] COMPLETE run=${runId} status=PASS firstAttempts=${firstRun.attempts} secondAttempts=${secondRun.attempts}`);console.log(`[autonomous-smoke] RESULT_PATH=${resultPath}`);
