import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFirstJsonObject } from './structured_output.mjs';

const TURN_SCHEMA = 'ResearchAgentTurn@1.0.0';
const ENGINE_EVIDENCE_SCHEMA = 'AutonomousResearchTaskEvidence@1.0.0';

function sha(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function nowIso() { return new Date().toISOString(); }
function engineError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function modelForRole(role, env, modelRegistry) {
  const envKey = role === 'LOCAL_FAST' ? 'LOCAL_LLM_FAST_MODEL' : role === 'LOCAL_CODER' ? 'LOCAL_LLM_CODER_MODEL' : 'LOCAL_LLM_REASONER_MODEL';
  const configured = String(env[envKey] || '').trim();
  if (configured) return { role, model: configured, source: 'ENV' };
  const selected = String(modelRegistry.roles?.find(x => x.role === role)?.selectedModel || '').trim();
  return { role, model: selected, source: selected ? 'REGISTRY' : 'NONE' };
}
function modelCandidates(primaryRole, env, modelRegistry) {
  const roles = [primaryRole, 'LOCAL_REASONER'];
  const seen = new Set();
  return roles.filter(role => role && !seen.has(role) && seen.add(role)).map(role => modelForRole(role, env, modelRegistry)).filter(x => x.model);
}

function enabledResearchTools(toolRegistry) {
  return (toolRegistry.tools || []).filter(x => x.enabled && x.readOnly === true && x.brokerAction === false);
}
function registeredFeatureTool(toolRegistry, toolName) {
  const tool = enabledResearchTools(toolRegistry).find(x => x.tool === toolName);
  if (!tool) throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', toolName);
  return tool;
}
function actionSemanticSchema(toolRegistry) {
  const tools = enabledResearchTools(toolRegistry);
  if (!tools.length) throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', 'no read-only research tool');
  const featureIds = [...new Set(tools.flatMap(x => x.allowedFeatureIds || []))];
  const periodMin = Math.min(...tools.map(x => Number(x.parameterContract?.period?.min ?? 2)));
  const periodMax = Math.max(...tools.map(x => Number(x.parameterContract?.period?.max ?? 240)));
  return {
    type: 'object', additionalProperties: false,
    required: ['tool', 'featureId', 'period', 'reasoningSummary'],
    properties: {
      tool: { type: 'string', enum: tools.map(x => x.tool) },
      featureId: { type: 'string', enum: featureIds },
      period: { type: 'integer', minimum: periodMin, maximum: periodMax },
      reasoningSummary: { type: 'string', maxLength: 1200 },
    },
  };
}
function validateActionSemantic(value, toolRegistry) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw engineError('AUTONOMOUS_ACTION_INVALID', 'object required');
  const tool = registeredFeatureTool(toolRegistry, String(value.tool || ''));
  const featureId = String(value.featureId || '');
  const period = Number(value.period);
  if (!(tool.allowedFeatureIds || []).includes(featureId)) throw engineError('AUTONOMOUS_ACTION_INVALID', `feature=${featureId}`);
  if (!Number.isInteger(period) || period < Number(tool.parameterContract?.period?.min) || period > Number(tool.parameterContract?.period?.max)) throw engineError('AUTONOMOUS_ACTION_INVALID', `period=${value.period}`);
  if (typeof value.reasoningSummary !== 'string' || !value.reasoningSummary.trim()) throw engineError('AUTONOMOUS_ACTION_INVALID', 'reasoningSummary required');
  return { tool: tool.tool, featureId, period, reasoningSummary: value.reasoningSummary.trim() };
}
function normalizeAction(goalId, semantic, toolRegistry) {
  const checked = validateActionSemantic(semantic, toolRegistry);
  const actionId = `ACTION-${sha({ goalId, tool: checked.tool, featureId: checked.featureId, period: checked.period }).slice(0, 16)}`;
  return {
    schema: TURN_SCHEMA,
    goalId,
    status: 'ACTION_REQUIRED',
    reasoningSummary: checked.reasoningSummary,
    actions: [{ actionId, tool: checked.tool, arguments: { featureId: checked.featureId, parameters: { period: checked.period } } }],
    evidenceRefs: [], conclusion: '', nextResearch: [], profitabilityClaim: false,
  };
}

function completionSemanticSchema(evidenceId, evidence) {
  const d = evidence.evidence;
  return {
    type: 'object', additionalProperties: false,
    required: ['evidenceId', 'observedEventCount', 'observedDiscoverySampleCount', 'observedValidationSampleCount', 'reasoningSummary', 'conclusion', 'nextResearch'],
    properties: {
      evidenceId: { type: 'string', enum: [evidenceId] },
      observedEventCount: { type: 'integer', enum: [Number(d.eventCount)] },
      observedDiscoverySampleCount: { type: 'integer', enum: [Number(d.discovery?.sampleCount ?? 0)] },
      observedValidationSampleCount: { type: 'integer', enum: [Number(d.validation?.sampleCount ?? 0)] },
      reasoningSummary: { type: 'string', maxLength: 1200 },
      conclusion: { type: 'string', maxLength: 2200 },
      nextResearch: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 1000 } },
    },
  };
}
function validateCompletionSemantic(value, evidenceId, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'object required');
  const d = evidence.evidence;
  if (value.evidenceId !== evidenceId) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'evidenceId mismatch');
  if (Number(value.observedEventCount) !== Number(d.eventCount)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'eventCount mismatch');
  if (Number(value.observedDiscoverySampleCount) !== Number(d.discovery?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'discovery sample mismatch');
  if (Number(value.observedValidationSampleCount) !== Number(d.validation?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'validation sample mismatch');
  if (typeof value.reasoningSummary !== 'string' || !value.reasoningSummary.trim()) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'reasoningSummary required');
  if (typeof value.conclusion !== 'string' || !value.conclusion.trim()) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'conclusion required');
  if (!Array.isArray(value.nextResearch)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'nextResearch required');
  return value;
}
function normalizeCompletion(goalId, semantic, evidenceId, evidence) {
  const checked = validateCompletionSemantic(semantic, evidenceId, evidence);
  return {
    schema: TURN_SCHEMA,
    goalId,
    status: 'COMPLETE',
    reasoningSummary: checked.reasoningSummary,
    actions: [], evidenceRefs: [evidenceId], conclusion: checked.conclusion,
    nextResearch: checked.nextResearch, profitabilityClaim: false,
  };
}

async function callModel({ base, choice, messages, schema, timeoutSeconds, contextTokens, outputTokens }) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutSeconds * 1000),
    body: JSON.stringify({
      model: choice.model, messages, format: schema, think: false, stream: false, keep_alive: 0,
      options: { temperature: 0, num_ctx: contextTokens, num_predict: outputTokens },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw engineError(`OLLAMA_HTTP_${response.status}`, `${choice.model}:${raw.slice(0, 500)}`);
  let body;
  try { body = JSON.parse(raw); } catch { throw engineError('OLLAMA_ENVELOPE_INVALID', choice.model); }
  return { body, text: String(body?.message?.content || '').trim() };
}

async function runSemanticDecision({ stage, schema, validate, messages, candidates, base, timeoutSeconds, contextTokens, outputTokens }) {
  let lastError = 'OUTPUT_INVALID';
  let globalAttempt = 0;
  const diagnostics = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const choice = candidates[candidateIndex];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      globalAttempt += 1;
      const correction = globalAttempt === 1 ? null : `Continue the SAME goal and evidence. Previous response was invalid: ${lastError}. Return only the exact small JSON object requested by this stage.`;
      const turnMessages = correction ? [...messages, { role: 'user', content: correction }] : messages;
      let call = null;
      let parsed = { value: null, error: null, strict: null, recovered: null, trailing: null };
      let decision = null;
      let error = null;
      try {
        call = await callModel({ base, choice, messages: turnMessages, schema, timeoutSeconds, contextTokens, outputTokens });
        parsed = parseFirstJsonObject(call.text);
        if (!parsed.value) error = `JSON_PARSE_FAILED:${parsed.error || 'unknown'}`;
        else {
          try { decision = validate(parsed.value); } catch (e) { error = String(e?.message || e); }
        }
      } catch (e) { error = String(e?.message || e); }
      diagnostics.push({ stage, globalAttempt, role: choice.role, model: choice.model, modelSource: choice.source, attempt, error, doneReason: call?.body?.done_reason ?? null, parseStrict: parsed.strict ?? null, parseRecovered: parsed.recovered ?? null, parseTrailing: parsed.trailing ?? null });
      if (decision) return { decision, attempts: globalAttempt, role: choice.role, model: choice.model, modelSource: choice.source, escalated: candidateIndex > 0, diagnostics };
      lastError = error || 'OUTPUT_INVALID';
    }
  }
  const error = engineError('AUTONOMOUS_OUTPUT_INVALID_AFTER_ESCALATION', `${stage}:${lastError}`);
  error.diagnostics = diagnostics;
  throw error;
}

function executeResearchAction({ action, goal, env, toolRegistry }) {
  const semantic = validateActionSemantic({
    tool: action.tool,
    featureId: action.arguments?.featureId,
    period: action.arguments?.parameters?.period,
    reasoningSummary: 'runtime validation',
  }, toolRegistry);
  const researchRoot = String(env.RESEARCH_LOCAL_ROOT || '').trim();
  if (!researchRoot) throw engineError('AUTONOMOUS_CONFIG_MISSING', 'RESEARCH_LOCAL_ROOT');
  const executor = path.join(researchRoot, 'scripts', 'run_feature_experiment_tool.mjs');
  if (!fs.existsSync(executor)) throw engineError('AUTONOMOUS_TOOL_EXECUTOR_MISSING', executor);
  const datasetHash = String(goal.toolContext?.datasetHash || '').trim();
  const snapshotExperiment = String(goal.toolContext?.snapshotExperiment || '').trim();
  if (!datasetHash || !snapshotExperiment) throw engineError('AUTONOMOUS_GOAL_INVALID', 'toolContext datasetHash/snapshotExperiment required');
  const args = [executor, '--feature', semantic.featureId, '--period', String(semantic.period), '--dataset', datasetHash, '--snapshot-experiment', snapshotExperiment];
  const child = spawnSync(process.execPath, args, { cwd: researchRoot, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (child.error) throw engineError('AUTONOMOUS_TOOL_SPAWN_FAILED', child.error.message);
  if (child.status !== 0) throw engineError('AUTONOMOUS_TOOL_FAILED', `exit=${child.status}:${String(child.stderr || '').slice(0, 700)}`);
  let evidence;
  try { evidence = JSON.parse(String(child.stdout || '').trim()); } catch { throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', String(child.stdout || '').slice(0, 700)); }
  if (evidence.schema !== 'ResearchToolEvidence@1.0.0' || evidence.profitabilityClaim !== false) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'schema/profitabilityClaim');
  const evidenceId = `EVIDENCE-${sha(evidence).slice(0, 16)}`;
  return { evidenceId, actionId: action.actionId, createdAt: nowIso(), evidence };
}

function buildResearchPrompt({ root, task, agent, goal, toolRegistry }) {
  const agentRoot = path.join(root, 'agents', agent.agentId);
  const readOptional = file => fs.existsSync(file) ? readText(file) : '';
  const skillFiles = ['skills/research-loop/SKILL.md', 'skills/profit-feature-explorer/SKILL.md', 'skills/research-tools/SKILL.md'];
  const skills = skillFiles.map(file => ({ file, text: readOptional(path.join(root, file)) }));
  return [
    '# AGENT', readOptional(path.join(agentRoot, 'AGENT.md')),
    '# DURABLE GOALS', readOptional(path.join(agentRoot, 'GOALS.md')),
    '# PLAN', readOptional(path.join(agentRoot, 'PLAN.md')),
    '# MEMORY INDEX', readOptional(path.join(agentRoot, 'MEMORY_INDEX.md')),
    '# SHARED OBJECTIVES', readOptional(path.join(root, 'shared', 'OBJECTIVES.md')),
    '# SHARED RULES', readOptional(path.join(root, 'shared', 'RESEARCH_RULES.md')),
    '# QUEUED TASK', JSON.stringify(task, null, 2),
    '# ASSIGNED RESEARCH GOAL', JSON.stringify(goal, null, 2),
    '# SKILLS', ...skills.flatMap(x => [`## ${x.file}`, x.text]),
    '# TOOL REGISTRY', JSON.stringify(toolRegistry, null, 2),
    '# RUNTIME BOUNDARY', 'You choose semantic research intent/tool arguments and interpret returned evidence. Runtime owns ids, canonical envelopes, hashes, tool execution and broker safety. Never request or perform broker/order actions.',
  ].join('\n\n');
}

export async function runAutonomousResearchTask({ root, task, agent, env }) {
  const started = Date.now();
  const goalFile = path.join(root, 'goals', `${task.goalId}.json`);
  if (!fs.existsSync(goalFile)) throw engineError('AUTONOMOUS_GOAL_MISSING', task.goalId);
  const goal = readJson(goalFile);
  if (goal.schema !== 'ResearchGoal@1.0.0' || goal.goalId !== task.goalId || goal.agentId !== task.agentId) throw engineError('AUTONOMOUS_GOAL_INVALID', task.goalId);
  const toolRegistry = readJson(path.join(root, 'registry', 'research_tools.json'));
  const modelRegistry = readJson(path.join(root, 'registry', 'models.json'));
  const primaryRole = task.modelRoleHint || agent.modelRoleHint || 'LOCAL_REASONER';
  const candidates = modelCandidates(primaryRole, env, modelRegistry);
  if (!candidates.length) throw engineError('MODEL_NOT_CONFIGURED', primaryRole);
  const base = String(env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const timeoutSeconds = Math.max(30, Number(env.LOCAL_LLM_TIMEOUT_SECONDS || 120));
  const contextTokens = Math.max(8192, Number(env.LOCAL_LLM_CONTEXT_TOKENS || 8192));
  const outputTokens = Math.max(512, Number(env.LOCAL_LLM_MAX_OUTPUT_TOKENS || 768));
  const common = buildResearchPrompt({ root, task, agent, goal, toolRegistry });

  const actionRun = await runSemanticDecision({
    stage: 'ACTION_DECISION', schema: actionSemanticSchema(toolRegistry), validate: value => validateActionSemantic(value, toolRegistry), candidates,
    base, timeoutSeconds, contextTokens, outputTokens,
    messages: [
      { role: 'system', content: 'You are an evidence-bound local research agent. Return only the requested small JSON decision. Use only whitelisted read-only research tools.' },
      { role: 'user', content: `${common}\n\n# ACTION DECISION\nRead the goal and available capability contracts. Choose the minimum deterministic action required. Return only tool, featureId, period and reasoningSummary. Do not invent evidence.` },
    ],
  });
  const firstTurn = normalizeAction(goal.goalId, actionRun.decision, toolRegistry);
  if (firstTurn.actions.length !== 1) throw engineError('AUTONOMOUS_CANONICAL_ACTION_INVALID');
  const evidence = executeResearchAction({ action: firstTurn.actions[0], goal, env, toolRegistry });

  const completionCandidates = modelCandidates(actionRun.role, env, modelRegistry);
  const completionRun = await runSemanticDecision({
    stage: 'COMPLETION_DECISION', schema: completionSemanticSchema(evidence.evidenceId, evidence), validate: value => validateCompletionSemantic(value, evidence.evidenceId, evidence), candidates: completionCandidates,
    base, timeoutSeconds, contextTokens, outputTokens,
    messages: [
      { role: 'system', content: 'You are the same evidence-bound local research agent continuing the queued task. Return only the requested small JSON evidence interpretation.' },
      { role: 'user', content: `${common}\n\n# PRIOR TURN\n${JSON.stringify(firstTurn, null, 2)}\n\n# TOOL EVIDENCE\n${JSON.stringify(evidence, null, 2)}\n\n# COMPLETION DECISION\nRead the evidence. Repeat the exact evidenceId, total eventCount, discovery sampleCount and validation sampleCount, then give a concise evidence-bound conclusion and optional nextResearch. Do not request another action in this one-shot lane.` },
    ],
  });
  const finalTurn = normalizeCompletion(goal.goalId, completionRun.decision, evidence.evidenceId, evidence);
  const autonomousResearch = {
    schema: ENGINE_EVIDENCE_SCHEMA,
    goalId: goal.goalId,
    semanticActionDecision: actionRun.decision,
    firstTurn,
    toolEvidence: evidence,
    semanticCompletionDecision: completionRun.decision,
    finalTurn,
    modelExecution: {
      actionDecision: { role: actionRun.role, model: actionRun.model, source: actionRun.modelSource, attempts: actionRun.attempts, escalated: actionRun.escalated },
      completionDecision: { role: completionRun.role, model: completionRun.model, source: completionRun.modelSource, attempts: completionRun.attempts, escalated: completionRun.escalated },
    },
    profitabilityClaim: false,
  };
  return {
    text: finalTurn.conclusion,
    workProduct: null,
    sourceRefs: [],
    model: completionRun.model,
    role: completionRun.role,
    autonomousResearch,
    runtimeMetrics: {
      wallSeconds: (Date.now() - started) / 1000,
      contextBytes: Buffer.byteLength(common, 'utf8'),
      outputAttempts: actionRun.attempts + completionRun.attempts,
      actionAttempts: actionRun.attempts,
      completionAttempts: completionRun.attempts,
      actionModelRole: actionRun.role,
      completionModelRole: completionRun.role,
      keepAlive: 0,
    },
  };
}

export function selfTestAutonomousResearchEngine({ root }) {
  const toolRegistry = readJson(path.join(root, 'registry', 'research_tools.json'));
  const semantic = validateActionSemantic({ tool: 'RUN_FEATURE_EXPERIMENT', featureId: 'PRICE_MA_RECLAIM_UP', period: 5, reasoningSummary: 'synthetic' }, toolRegistry);
  const turn = normalizeAction('SELFTEST-GOAL', semantic, toolRegistry);
  if (turn.actions[0].arguments.parameters.period !== 5) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'action');
  const evidence = { evidenceId: 'EVIDENCE-SELFTEST', evidence: { eventCount: 12, discovery: { sampleCount: 8 }, validation: { sampleCount: 4 } } };
  const completion = normalizeCompletion('SELFTEST-GOAL', { evidenceId: 'EVIDENCE-SELFTEST', observedEventCount: 12, observedDiscoverySampleCount: 8, observedValidationSampleCount: 4, reasoningSummary: 'synthetic', conclusion: 'synthetic', nextResearch: [] }, 'EVIDENCE-SELFTEST', evidence);
  if (completion.evidenceRefs[0] !== 'EVIDENCE-SELFTEST') throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'completion');
  return true;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes('--self-test')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  selfTestAutonomousResearchEngine({ root });
  console.log('AUTONOMOUS_RESEARCH_ENGINE_SELF_TEST_PASS');
}
