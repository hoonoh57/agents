import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFirstJsonObject } from './structured_output.mjs';

const TURN_SCHEMA = 'ResearchAgentTurn@1.0.0';
const ENGINE_EVIDENCE_SCHEMA = 'AutonomousResearchTaskEvidence@1.0.0';
const TOOL_EXPERIMENT = 'RUN_FEATURE_EXPERIMENT';
const TOOL_PERIOD_SEARCH = 'RUN_FEATURE_PERIOD_SEARCH';
const TOOL_HIGH_BREAKOUT_DISCOVERY = 'RUN_HIGH_BREAKOUT_DISCOVERY_SEARCH';

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
  return roles
    .filter(role => role && !seen.has(role) && seen.add(role))
    .map(role => modelForRole(role, env, modelRegistry))
    .filter(x => x.model);
}

function enabledResearchTools(toolRegistry) {
  return (toolRegistry.tools || []).filter(x => x.enabled && x.readOnly === true && x.brokerAction === false);
}
function registeredFeatureTool(toolRegistry, toolName) {
  const tool = enabledResearchTools(toolRegistry).find(x => x.tool === toolName);
  if (!tool) throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', toolName);
  return tool;
}
function integerContractValue(value, name, contract) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw engineError('AUTONOMOUS_ACTION_INVALID', `${name}=${String(value ?? 'missing')}`);
  const min = Number(contract?.min ?? Number.MIN_SAFE_INTEGER);
  const max = Number(contract?.max ?? Number.MAX_SAFE_INTEGER);
  if (parsed < min || parsed > max) throw engineError('AUTONOMOUS_ACTION_INVALID', `${name}=${parsed}`);
  return parsed;
}

function actionSemanticSchema(toolRegistry) {
  const tools = enabledResearchTools(toolRegistry);
  if (!tools.length) throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', 'no read-only research tool');
  const featureIds = [...new Set(tools.flatMap(x => x.allowedFeatureIds || []))];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tool', 'featureId', 'reasoningSummary'],
    properties: {
      tool: { type: 'string', enum: tools.map(x => x.tool) },
      featureId: { type: 'string', enum: featureIds },
      period: { type: 'integer', minimum: 2, maximum: 240 },
      periodMin: { type: 'integer', minimum: 2, maximum: 240 },
      periodMax: { type: 'integer', minimum: 2, maximum: 240 },
      periodStep: { type: 'integer', minimum: 1, maximum: 60 },
      lookbackMin: { type: 'integer', minimum: 2, maximum: 240 },
      lookbackMax: { type: 'integer', minimum: 2, maximum: 240 },
      lookbackStep: { type: 'integer', minimum: 1, maximum: 60 },
      reasoningSummary: { type: 'string', maxLength: 1200 },
    },
  };
}

function validateRange(minValue, maxValue, stepValue, names, contracts) {
  const min = integerContractValue(minValue, names.min, contracts.min);
  const max = integerContractValue(maxValue, names.max, contracts.max);
  const step = integerContractValue(stepValue, names.step, contracts.step);
  if (min > max) throw engineError('AUTONOMOUS_ACTION_INVALID', `${names.min}=${min}>${names.max}=${max}`);
  const candidateCount = Math.floor((max - min) / step) + 1;
  if (candidateCount < 1 || candidateCount > 120) throw engineError('AUTONOMOUS_ACTION_INVALID', `candidateCount=${candidateCount}`);
  return { min, max, step };
}

function validateActionSemantic(value, toolRegistry) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw engineError('AUTONOMOUS_ACTION_INVALID', 'object required');
  const tool = registeredFeatureTool(toolRegistry, String(value.tool || ''));
  const featureId = String(value.featureId || '');
  if (!(tool.allowedFeatureIds || []).includes(featureId)) throw engineError('AUTONOMOUS_ACTION_INVALID', `feature=${featureId}`);
  if (typeof value.reasoningSummary !== 'string' || !value.reasoningSummary.trim()) throw engineError('AUTONOMOUS_ACTION_INVALID', 'reasoningSummary required');
  const reasoningSummary = value.reasoningSummary.trim();

  if (tool.tool === TOOL_EXPERIMENT) {
    const period = integerContractValue(value.period, 'period', tool.parameterContract?.period);
    return { tool: tool.tool, featureId, period, reasoningSummary };
  }
  if (tool.tool === TOOL_PERIOD_SEARCH) {
    const r = validateRange(value.periodMin, value.periodMax, value.periodStep,
      { min: 'periodMin', max: 'periodMax', step: 'periodStep' },
      { min: tool.parameterContract?.periodMin, max: tool.parameterContract?.periodMax, step: tool.parameterContract?.periodStep });
    return { tool: tool.tool, featureId, periodMin: r.min, periodMax: r.max, periodStep: r.step, reasoningSummary };
  }
  if (tool.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    const r = validateRange(value.lookbackMin, value.lookbackMax, value.lookbackStep,
      { min: 'lookbackMin', max: 'lookbackMax', step: 'lookbackStep' },
      { min: tool.parameterContract?.lookbackMin, max: tool.parameterContract?.lookbackMax, step: tool.parameterContract?.lookbackStep });
    return { tool: tool.tool, featureId, lookbackMin: r.min, lookbackMax: r.max, lookbackStep: r.step, reasoningSummary };
  }
  throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', tool.tool);
}

function semanticParameters(semantic) {
  if (semantic.tool === TOOL_EXPERIMENT) return { period: semantic.period };
  if (semantic.tool === TOOL_PERIOD_SEARCH) return { periodMin: semantic.periodMin, periodMax: semantic.periodMax, periodStep: semantic.periodStep };
  if (semantic.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) return { lookbackMin: semantic.lookbackMin, lookbackMax: semantic.lookbackMax, lookbackStep: semantic.lookbackStep };
  throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', semantic.tool);
}

function normalizeAction(goalId, semantic, toolRegistry) {
  const checked = validateActionSemantic(semantic, toolRegistry);
  const parameters = semanticParameters(checked);
  const actionId = `ACTION-${sha({ goalId, tool: checked.tool, featureId: checked.featureId, parameters }).slice(0, 16)}`;
  return {
    schema: TURN_SCHEMA,
    goalId,
    status: 'ACTION_REQUIRED',
    reasoningSummary: checked.reasoningSummary,
    actions: [{ actionId, tool: checked.tool, arguments: { featureId: checked.featureId, parameters } }],
    evidenceRefs: [],
    conclusion: '',
    nextResearch: [],
    profitabilityClaim: false,
  };
}

function normalizeNextResearch(value) {
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 2);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function completionSemanticSchema(evidence) {
  const d = evidence.evidence;
  if (d.tool === TOOL_PERIOD_SEARCH) {
    const selected = d.selectedCandidate || null;
    const required = ['featureId', 'searchStatus', 'candidateCount', 'validationSampleCount', 'reasoningSummary', 'conclusion'];
    const properties = {
      featureId: { type: 'string', enum: [String(d.featureId)] },
      searchStatus: { type: 'string', enum: [String(d.status)] },
      candidateCount: { type: 'integer', enum: [Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0] },
      validationSampleCount: { type: 'integer', enum: [Number(d.validation?.sampleCount ?? 0)] },
      reasoningSummary: { type: 'string', maxLength: 1200 },
      conclusion: { type: 'string', maxLength: 2200 },
      nextResearch: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 1000 } },
    };
    if (selected) {
      required.push('selectedPeriod', 'discoverySampleCount');
      properties.selectedPeriod = { type: 'integer', enum: [Number(selected.period)] };
      properties.discoverySampleCount = { type: 'integer', enum: [Number(selected.discovery?.sampleCount ?? 0)] };
    }
    return { type: 'object', additionalProperties: false, required, properties };
  }

  if (d.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    const selected = d.selectedCandidate || null;
    const required = ['featureId', 'searchStatus', 'candidateCount', 'freshValidationStatus', 'reasoningSummary', 'conclusion'];
    const properties = {
      featureId: { type: 'string', enum: [String(d.featureId)] },
      searchStatus: { type: 'string', enum: [String(d.status)] },
      candidateCount: { type: 'integer', enum: [Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0] },
      freshValidationStatus: { type: 'string', enum: [String(d.freshValidation?.status)] },
      reasoningSummary: { type: 'string', maxLength: 1200 },
      conclusion: { type: 'string', maxLength: 2200 },
      nextResearch: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 1000 } },
    };
    if (selected) {
      required.push('selectedLookback', 'discoverySampleCount');
      properties.selectedLookback = { type: 'integer', enum: [Number(selected.lookback)] };
      properties.discoverySampleCount = { type: 'integer', enum: [Number(selected.discovery?.sampleCount ?? 0)] };
    }
    return { type: 'object', additionalProperties: false, required, properties };
  }

  return {
    type: 'object', additionalProperties: false,
    required: ['featureId', 'period', 'eventCount', 'discoverySampleCount', 'validationSampleCount', 'reasoningSummary', 'conclusion'],
    properties: {
      featureId: { type: 'string', enum: [String(d.featureId)] },
      period: { type: 'integer', enum: [Number(d.parameters?.period)] },
      eventCount: { type: 'integer', enum: [Number(d.eventCount)] },
      discoverySampleCount: { type: 'integer', enum: [Number(d.discovery?.sampleCount ?? 0)] },
      validationSampleCount: { type: 'integer', enum: [Number(d.validation?.sampleCount ?? 0)] },
      reasoningSummary: { type: 'string', maxLength: 1200 },
      conclusion: { type: 'string', maxLength: 2200 },
      nextResearch: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 1000 } },
    },
  };
}

function validateCompletionSemantic(value, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'object required');
  const d = evidence.evidence;
  if (String(value.featureId || '') !== String(d.featureId)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `feature mismatch actual=${String(value.featureId ?? 'missing')}`);

  if (d.tool === TOOL_PERIOD_SEARCH) {
    const candidateCount = Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0;
    if (String(value.searchStatus || '') !== String(d.status)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `searchStatus mismatch actual=${String(value.searchStatus ?? 'missing')}`);
    if (Number(value.candidateCount) !== candidateCount) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `candidateCount mismatch actual=${String(value.candidateCount ?? 'missing')}`);
    if (Number(value.validationSampleCount) !== Number(d.validation?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `validation sample mismatch actual=${String(value.validationSampleCount ?? 'missing')}`);
    if (d.selectedCandidate) {
      if (Number(value.selectedPeriod) !== Number(d.selectedCandidate.period)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `selectedPeriod mismatch actual=${String(value.selectedPeriod ?? 'missing')}`);
      if (Number(value.discoverySampleCount) !== Number(d.selectedCandidate.discovery?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `discovery sample mismatch actual=${String(value.discoverySampleCount ?? 'missing')}`);
    }
  } else if (d.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    const candidateCount = Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0;
    if (String(value.searchStatus || '') !== String(d.status)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `searchStatus mismatch actual=${String(value.searchStatus ?? 'missing')}`);
    if (Number(value.candidateCount) !== candidateCount) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `candidateCount mismatch actual=${String(value.candidateCount ?? 'missing')}`);
    if (String(value.freshValidationStatus || '') !== String(d.freshValidation?.status)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `freshValidationStatus mismatch actual=${String(value.freshValidationStatus ?? 'missing')}`);
    if (d.selectedCandidate) {
      if (Number(value.selectedLookback) !== Number(d.selectedCandidate.lookback)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `selectedLookback mismatch actual=${String(value.selectedLookback ?? 'missing')}`);
      if (Number(value.discoverySampleCount) !== Number(d.selectedCandidate.discovery?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `discovery sample mismatch actual=${String(value.discoverySampleCount ?? 'missing')}`);
    }
  } else {
    if (Number(value.period) !== Number(d.parameters?.period)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `period mismatch actual=${String(value.period ?? 'missing')}`);
    if (Number(value.eventCount) !== Number(d.eventCount)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `eventCount mismatch actual=${String(value.eventCount ?? 'missing')}`);
    if (Number(value.discoverySampleCount) !== Number(d.discovery?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `discovery sample mismatch actual=${String(value.discoverySampleCount ?? 'missing')}`);
    if (Number(value.validationSampleCount) !== Number(d.validation?.sampleCount ?? 0)) throw engineError('AUTONOMOUS_COMPLETION_INVALID', `validation sample mismatch actual=${String(value.validationSampleCount ?? 'missing')}`);
  }

  if (typeof value.reasoningSummary !== 'string' || !value.reasoningSummary.trim()) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'reasoningSummary required');
  if (typeof value.conclusion !== 'string' || !value.conclusion.trim()) throw engineError('AUTONOMOUS_COMPLETION_INVALID', 'conclusion required');
  return {
    ...value,
    reasoningSummary: value.reasoningSummary.trim(),
    conclusion: value.conclusion.trim(),
    nextResearch: normalizeNextResearch(value.nextResearch),
  };
}

function normalizeCompletion(goalId, semantic, evidenceId, evidence) {
  const checked = validateCompletionSemantic(semantic, evidence);
  return {
    schema: TURN_SCHEMA,
    goalId,
    status: 'COMPLETE',
    reasoningSummary: checked.reasoningSummary,
    actions: [],
    evidenceRefs: [evidenceId],
    conclusion: checked.conclusion,
    nextResearch: checked.nextResearch,
    profitabilityClaim: false,
  };
}

function semanticDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    keys: Object.keys(value).slice(0, 24),
    tool: value.tool ?? null,
    featureId: value.featureId ?? null,
    period: value.period ?? null,
    periodMin: value.periodMin ?? null,
    periodMax: value.periodMax ?? null,
    periodStep: value.periodStep ?? null,
    lookbackMin: value.lookbackMin ?? null,
    lookbackMax: value.lookbackMax ?? null,
    lookbackStep: value.lookbackStep ?? null,
    eventCount: value.eventCount ?? null,
    discoverySampleCount: value.discoverySampleCount ?? null,
    validationSampleCount: value.validationSampleCount ?? null,
    selectedPeriod: value.selectedPeriod ?? null,
    selectedLookback: value.selectedLookback ?? null,
    searchStatus: value.searchStatus ?? null,
    freshValidationStatus: value.freshValidationStatus ?? null,
    candidateCount: value.candidateCount ?? null,
    nextResearchType: Array.isArray(value.nextResearch) ? 'array' : value.nextResearch === null ? 'null' : typeof value.nextResearch,
  };
}

async function callModel({ base, choice, messages, schema, timeoutSeconds, contextTokens, outputTokens }) {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
    body: JSON.stringify({
      model: choice.model,
      messages,
      format: schema,
      think: false,
      stream: false,
      keep_alive: 0,
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
      diagnostics.push({
        stage,
        globalAttempt,
        role: choice.role,
        model: choice.model,
        modelSource: choice.source,
        attempt,
        error,
        doneReason: call?.body?.done_reason ?? null,
        parseStrict: parsed.strict ?? null,
        parseRecovered: parsed.recovered ?? null,
        parseTrailing: parsed.trailing ?? null,
        returned: semanticDiagnostic(parsed.value),
      });
      if (decision) return { decision, attempts: globalAttempt, role: choice.role, model: choice.model, modelSource: choice.source, escalated: candidateIndex > 0, diagnostics };
      lastError = error || 'OUTPUT_INVALID';
    }
  }
  const error = engineError('AUTONOMOUS_OUTPUT_INVALID_AFTER_ESCALATION', `${stage}:${lastError}`);
  error.diagnostics = diagnostics;
  throw error;
}

function semanticFromAction(action, toolRegistry) {
  const parameters = action.arguments?.parameters || {};
  return validateActionSemantic({
    tool: action.tool,
    featureId: action.arguments?.featureId,
    ...parameters,
    reasoningSummary: 'runtime validation',
  }, toolRegistry);
}

function resolveExecutor(researchRoot, tool) {
  const configured = String(tool.executor || '').replace(/\\/g, '/');
  const prefix = 'RESEARCH_LOCAL_ROOT/';
  if (!configured.startsWith(prefix)) throw engineError('AUTONOMOUS_TOOL_EXECUTOR_INVALID', configured);
  const relative = configured.slice(prefix.length);
  if (!relative || relative.split('/').includes('..')) throw engineError('AUTONOMOUS_TOOL_EXECUTOR_INVALID', configured);
  const resolvedRoot = path.resolve(researchRoot);
  const executor = path.resolve(resolvedRoot, relative);
  if (!(executor === resolvedRoot || executor.startsWith(resolvedRoot + path.sep))) throw engineError('AUTONOMOUS_TOOL_EXECUTOR_INVALID', executor);
  return executor;
}

function executeResearchAction({ action, goal, env, toolRegistry }) {
  const semantic = semanticFromAction(action, toolRegistry);
  const registeredTool = registeredFeatureTool(toolRegistry, semantic.tool);
  const researchRoot = String(env.RESEARCH_LOCAL_ROOT || '').trim();
  if (!researchRoot) throw engineError('AUTONOMOUS_CONFIG_MISSING', 'RESEARCH_LOCAL_ROOT');
  const executor = resolveExecutor(researchRoot, registeredTool);
  if (!fs.existsSync(executor)) throw engineError('AUTONOMOUS_TOOL_EXECUTOR_MISSING', executor);
  const datasetHash = String(goal.toolContext?.datasetHash || '').trim();
  const snapshotExperiment = String(goal.toolContext?.snapshotExperiment || '').trim();
  if (!datasetHash || !snapshotExperiment) throw engineError('AUTONOMOUS_GOAL_INVALID', 'toolContext datasetHash/snapshotExperiment required');

  const args = [executor, '--feature', semantic.featureId];
  if (semantic.tool === TOOL_EXPERIMENT) {
    args.push('--period', String(semantic.period));
  } else if (semantic.tool === TOOL_PERIOD_SEARCH) {
    args.push('--period-min', String(semantic.periodMin), '--period-max', String(semantic.periodMax), '--period-step', String(semantic.periodStep));
  } else if (semantic.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    args.push('--lookback-min', String(semantic.lookbackMin), '--lookback-max', String(semantic.lookbackMax), '--lookback-step', String(semantic.lookbackStep));
  } else {
    throw engineError('AUTONOMOUS_TOOL_UNAVAILABLE', semantic.tool);
  }
  args.push('--dataset', datasetHash, '--snapshot-experiment', snapshotExperiment);

  const child = spawnSync(process.execPath, args, { cwd: researchRoot, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (child.error) throw engineError('AUTONOMOUS_TOOL_SPAWN_FAILED', child.error.message);
  if (child.status !== 0) throw engineError('AUTONOMOUS_TOOL_FAILED', `exit=${child.status}:${String(child.stderr || '').slice(0, 700)}`);
  let evidence;
  try { evidence = JSON.parse(String(child.stdout || '').trim()); } catch { throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', String(child.stdout || '').slice(0, 700)); }
  if (evidence.schema !== 'ResearchToolEvidence@1.0.0' || evidence.profitabilityClaim !== false) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'schema/profitabilityClaim');
  if (String(evidence.tool) !== semantic.tool || String(evidence.featureId) !== semantic.featureId) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'tool/feature mismatch');

  if (semantic.tool === TOOL_EXPERIMENT) {
    if (Number(evidence.parameters?.period) !== semantic.period) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'period mismatch');
  } else if (semantic.tool === TOOL_PERIOD_SEARCH) {
    if (Number(evidence.parameters?.periodMin) !== semantic.periodMin || Number(evidence.parameters?.periodMax) !== semantic.periodMax || Number(evidence.parameters?.periodStep) !== semantic.periodStep) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'period search mismatch');
    if (evidence.method?.discoveryOnlyRanking !== true || evidence.method?.selectedCandidateFrozenBeforeValidation !== true || evidence.method?.nonSelectedValidationEvaluated !== false) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'holdout policy mismatch');
    const validationPeriods = Array.isArray(evidence.method?.validationEvaluatedPeriods) ? evidence.method.validationEvaluatedPeriods.map(Number) : [];
    if (validationPeriods.length > 1) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'multiple validation periods');
    if (evidence.selectedCandidate) {
      if (validationPeriods.length !== 1 || validationPeriods[0] !== Number(evidence.selectedCandidate.period)) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'selected validation period mismatch');
    } else if (validationPeriods.length !== 0) {
      throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'validation without selected candidate');
    }
  } else if (semantic.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    if (Number(evidence.parameters?.lookbackMin) !== semantic.lookbackMin || Number(evidence.parameters?.lookbackMax) !== semantic.lookbackMax || Number(evidence.parameters?.lookbackStep) !== semantic.lookbackStep) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'lookback search mismatch');
    if (evidence.method?.discoveryOnlyRanking !== true || evidence.method?.validationEvaluated !== false || evidence.method?.historicalValidationReuseAllowed !== false) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'fresh validation policy mismatch');
    if (evidence.freshValidation?.evaluated !== false) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'fresh validation already evaluated');
    if (String(evidence.method?.freshValidationRequiresDecisionDateAfter || '') !== String(evidence.dateTo || '')) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'fresh validation cutoff mismatch');
    if (evidence.selectedCandidate) {
      if (evidence.method?.selectedCandidateFrozenBeforeFreshValidation !== true) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'candidate not frozen');
      if (String(evidence.status) !== 'WAITING_FOR_FRESH_VALIDATION' || String(evidence.freshValidation?.status) !== 'WAITING_FOR_FRESH_VALIDATION') throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'waiting status mismatch');
      if (String(evidence.selectedCandidate.frozenAtDataCutoff || '') !== String(evidence.dateTo || '')) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'candidate cutoff mismatch');
    } else {
      if (!['NO_GO_DISCOVERY', 'NO_GO_NO_DISCOVERY_EVENTS'].includes(String(evidence.status))) throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'unexpected discovery status');
      if (String(evidence.freshValidation?.status) !== 'NOT_ELIGIBLE') throw engineError('AUTONOMOUS_TOOL_EVIDENCE_INVALID', 'ineligible fresh validation mismatch');
    }
  }

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

function compactEvidenceForCompletion(goal, firstTurn, evidence) {
  const d = evidence.evidence;
  const base = {
    goal: { goalId: goal.goalId, purpose: goal.purpose, objective: goal.objective, constraints: goal.constraints },
    priorAction: {
      tool: firstTurn.actions[0]?.tool,
      featureId: firstTurn.actions[0]?.arguments?.featureId,
      parameters: firstTurn.actions[0]?.arguments?.parameters,
    },
  };

  if (d.tool === TOOL_PERIOD_SEARCH) {
    return {
      ...base,
      toolEvidence: {
        tool: d.tool, featureId: d.featureId, parameters: d.parameters, datasetHash: d.datasetHash,
        snapshotExperiment: d.snapshotExperiment, dateFrom: d.dateFrom, dateTo: d.dateTo, validationStart: d.validationStart,
        requestedSymbolCount: d.requestedSymbolCount, effectiveSymbolCount: d.effectiveSymbolCount, excludedSymbols: d.excludedSymbols,
        method: d.method, candidateCount: Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0,
        topDiscoveryCandidates: Array.isArray(d.discoveryRanking) ? d.discoveryRanking.slice(0, 8) : [],
        selectedCandidate: d.selectedCandidate, validation: d.validation, status: d.status, profitabilityClaim: false,
      },
      runtimeNote: 'All ids are runtime-owned. Read the holdout-safe search evidence. Do not request validation for another period and do not change the ranking after seeing Validation.',
    };
  }

  if (d.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    return {
      ...base,
      toolEvidence: {
        tool: d.tool, featureId: d.featureId, parameters: d.parameters, datasetHash: d.datasetHash,
        snapshotExperiment: d.snapshotExperiment, dateFrom: d.dateFrom, dateTo: d.dateTo,
        requestedSymbolCount: d.requestedSymbolCount, effectiveSymbolCount: d.effectiveSymbolCount, excludedSymbols: d.excludedSymbols,
        method: d.method, candidateCount: Array.isArray(d.discoveryRanking) ? d.discoveryRanking.length : 0,
        topDiscoveryCandidates: Array.isArray(d.discoveryRanking) ? d.discoveryRanking.slice(0, 8) : [],
        selectedCandidate: d.selectedCandidate, freshValidation: d.freshValidation, status: d.status, profitabilityClaim: false,
      },
      runtimeNote: 'All ids are runtime-owned. This is Discovery only. Historical Validation reuse is forbidden. If a candidate is frozen, preserve WAITING_FOR_FRESH_VALIDATION and do not request immediate Validation.',
    };
  }

  return {
    ...base,
    toolEvidence: {
      tool: d.tool, featureId: d.featureId, parameters: d.parameters, datasetHash: d.datasetHash, snapshotExperiment: d.snapshotExperiment,
      dateFrom: d.dateFrom, dateTo: d.dateTo, validationStart: d.validationStart, requestedSymbolCount: d.requestedSymbolCount,
      effectiveSymbolCount: d.effectiveSymbolCount, excludedSymbols: d.excludedSymbols, eventCount: d.eventCount,
      all: d.all, discovery: d.discovery, validation: d.validation, profitabilityClaim: false,
    },
    runtimeNote: 'All ids are runtime-owned. Prove evidence reading by returning the exact featureId, period, eventCount, discovery sampleCount and validation sampleCount.',
  };
}

function completionInstruction(evidence) {
  const d = evidence.evidence;
  if (d.tool === TOOL_PERIOD_SEARCH) {
    const selectedFields = d.selectedCandidate ? ' Also return selectedPeriod and discoverySampleCount for the frozen candidate.' : ' There is no frozen candidate, so omit selectedPeriod and discoverySampleCount.';
    return `Read only the supplied holdout-safe search evidence. Return featureId, searchStatus, candidateCount, validationSampleCount, reasoningSummary and conclusion.${selectedFields} nextResearch is optional. Preserve the tool status exactly; do not reinterpret a NO_GO as success and do not request another Validation action.`;
  }
  if (d.tool === TOOL_HIGH_BREAKOUT_DISCOVERY) {
    const selectedFields = d.selectedCandidate ? ' Also return selectedLookback and discoverySampleCount for the frozen candidate.' : ' There is no frozen candidate, so omit selectedLookback and discoverySampleCount.';
    return `Read only the supplied Discovery evidence. Return featureId, searchStatus, candidateCount, freshValidationStatus, reasoningSummary and conclusion.${selectedFields} nextResearch is optional. Preserve WAITING_FOR_FRESH_VALIDATION or NO_GO exactly. Do not request immediate Validation and do not reuse historical holdout data.`;
  }
  return 'Read only the supplied evidence. Return featureId, period, eventCount, discoverySampleCount, validationSampleCount, reasoningSummary and conclusion. nextResearch is optional; omit it when there is no useful follow-up. Do not return any evidenceId and do not request another action in this one-shot lane.';
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
    stage: 'ACTION_DECISION',
    schema: actionSemanticSchema(toolRegistry),
    validate: value => validateActionSemantic(value, toolRegistry),
    candidates,
    base,
    timeoutSeconds,
    contextTokens,
    outputTokens,
    messages: [
      { role: 'system', content: 'You are an evidence-bound local research agent. Return only the requested small JSON decision. Use only whitelisted read-only research tools.' },
      { role: 'user', content: `${common}\n\n# ACTION DECISION\nRead the goal and capability/tool contracts. Choose the minimum deterministic action required. Return tool, featureId, reasoningSummary and exactly the flat parameters required by that tool: period for RUN_FEATURE_EXPERIMENT; periodMin/periodMax/periodStep for RUN_FEATURE_PERIOD_SEARCH; or lookbackMin/lookbackMax/lookbackStep for RUN_HIGH_BREAKOUT_DISCOVERY_SEARCH. Derive values from the human goal and existing capability contract. Do not invent evidence.` },
    ],
  });
  const firstTurn = normalizeAction(goal.goalId, actionRun.decision, toolRegistry);
  if (firstTurn.actions.length !== 1) throw engineError('AUTONOMOUS_CANONICAL_ACTION_INVALID');
  const evidence = executeResearchAction({ action: firstTurn.actions[0], goal, env, toolRegistry });

  const completionContext = compactEvidenceForCompletion(goal, firstTurn, evidence);
  const completionCandidates = modelCandidates(actionRun.role, env, modelRegistry);
  const completionRun = await runSemanticDecision({
    stage: 'COMPLETION_DECISION',
    schema: completionSemanticSchema(evidence),
    validate: value => validateCompletionSemantic(value, evidence),
    candidates: completionCandidates,
    base,
    timeoutSeconds,
    contextTokens,
    outputTokens,
    messages: [
      { role: 'system', content: 'You are the same evidence-bound local research agent continuing the queued task. Return only the requested small JSON evidence interpretation. Runtime owns all ids.' },
      { role: 'user', content: `# COMPACT COMPLETION CONTEXT\n${JSON.stringify(completionContext, null, 2)}\n\n# COMPLETION DECISION\n${completionInstruction(evidence)}` },
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
      actionDecision: { role: actionRun.role, model: actionRun.model, source: actionRun.modelSource, attempts: actionRun.attempts, escalated: actionRun.escalated, diagnostics: actionRun.diagnostics },
      completionDecision: { role: completionRun.role, model: completionRun.model, source: completionRun.modelSource, attempts: completionRun.attempts, escalated: completionRun.escalated, diagnostics: completionRun.diagnostics },
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
      completionContextBytes: Buffer.byteLength(JSON.stringify(completionContext), 'utf8'),
      contextTokens,
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

  const experiment = validateActionSemantic({ tool: TOOL_EXPERIMENT, featureId: 'PRICE_MA_RECLAIM_UP', period: 5, reasoningSummary: 'synthetic' }, toolRegistry);
  const experimentTurn = normalizeAction('SELFTEST-GOAL', experiment, toolRegistry);
  if (experimentTurn.actions[0].arguments.parameters.period !== 5) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'experiment action');
  const experimentEvidence = { evidenceId: 'EVIDENCE-SELFTEST', evidence: { tool: TOOL_EXPERIMENT, featureId: 'PRICE_MA_RECLAIM_UP', parameters: { period: 5 }, eventCount: 12, discovery: { sampleCount: 8 }, validation: { sampleCount: 4 } } };
  const experimentCompletion = normalizeCompletion('SELFTEST-GOAL', {
    featureId: 'PRICE_MA_RECLAIM_UP', period: 5, eventCount: 12, discoverySampleCount: 8, validationSampleCount: 4,
    reasoningSummary: 'synthetic', conclusion: 'synthetic',
  }, 'EVIDENCE-SELFTEST', experimentEvidence);
  if (experimentCompletion.evidenceRefs[0] !== 'EVIDENCE-SELFTEST' || experimentCompletion.nextResearch.length !== 0) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'experiment completion');

  const search = validateActionSemantic({ tool: TOOL_PERIOD_SEARCH, featureId: 'PRICE_MA_RECLAIM_UP', periodMin: 5, periodMax: 120, periodStep: 5, reasoningSummary: 'synthetic search' }, toolRegistry);
  const searchTurn = normalizeAction('SELFTEST-SEARCH', search, toolRegistry);
  if (searchTurn.actions[0].arguments.parameters.periodMin !== 5 || searchTurn.actions[0].arguments.parameters.periodMax !== 120 || searchTurn.actions[0].arguments.parameters.periodStep !== 5) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'search action');
  const searchEvidence = {
    evidenceId: 'EVIDENCE-SEARCH',
    evidence: {
      tool: TOOL_PERIOD_SEARCH,
      featureId: 'PRICE_MA_RECLAIM_UP',
      parameters: { periodMin: 5, periodMax: 120, periodStep: 5 },
      discoveryRanking: [{ rank: 1, period: 20, discovery: { sampleCount: 8 } }],
      selectedCandidate: { period: 20, discovery: { sampleCount: 8 } },
      validation: { sampleCount: 4 },
      status: 'NO_GO_VALIDATION',
    },
  };
  const searchCompletion = normalizeCompletion('SELFTEST-SEARCH', {
    featureId: 'PRICE_MA_RECLAIM_UP', searchStatus: 'NO_GO_VALIDATION', candidateCount: 1, selectedPeriod: 20,
    discoverySampleCount: 8, validationSampleCount: 4, reasoningSummary: 'synthetic search', conclusion: 'synthetic no-go',
  }, 'EVIDENCE-SEARCH', searchEvidence);
  if (searchCompletion.evidenceRefs[0] !== 'EVIDENCE-SEARCH' || searchCompletion.nextResearch.length !== 0) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'search completion');

  const discovery = validateActionSemantic({
    tool: TOOL_HIGH_BREAKOUT_DISCOVERY,
    featureId: 'PRICE_N_HIGH_BREAKOUT',
    lookbackMin: 5,
    lookbackMax: 120,
    lookbackStep: 5,
    reasoningSummary: 'synthetic discovery',
  }, toolRegistry);
  const discoveryTurn = normalizeAction('SELFTEST-DISCOVERY', discovery, toolRegistry);
  if (discoveryTurn.actions[0].arguments.parameters.lookbackMin !== 5 || discoveryTurn.actions[0].arguments.parameters.lookbackMax !== 120 || discoveryTurn.actions[0].arguments.parameters.lookbackStep !== 5) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'discovery action');
  const discoveryEvidence = {
    evidenceId: 'EVIDENCE-DISCOVERY',
    evidence: {
      tool: TOOL_HIGH_BREAKOUT_DISCOVERY,
      featureId: 'PRICE_N_HIGH_BREAKOUT',
      parameters: { lookbackMin: 5, lookbackMax: 120, lookbackStep: 5 },
      discoveryRanking: [{ rank: 1, lookback: 20, discovery: { sampleCount: 9 } }],
      selectedCandidate: { lookback: 20, discovery: { sampleCount: 9 } },
      freshValidation: { status: 'WAITING_FOR_FRESH_VALIDATION', evaluated: false },
      status: 'WAITING_FOR_FRESH_VALIDATION',
    },
  };
  const discoveryCompletion = normalizeCompletion('SELFTEST-DISCOVERY', {
    featureId: 'PRICE_N_HIGH_BREAKOUT', searchStatus: 'WAITING_FOR_FRESH_VALIDATION', candidateCount: 1,
    freshValidationStatus: 'WAITING_FOR_FRESH_VALIDATION', selectedLookback: 20, discoverySampleCount: 9,
    reasoningSummary: 'synthetic discovery', conclusion: 'synthetic waiting',
  }, 'EVIDENCE-DISCOVERY', discoveryEvidence);
  if (discoveryCompletion.evidenceRefs[0] !== 'EVIDENCE-DISCOVERY' || discoveryCompletion.nextResearch.length !== 0) throw engineError('AUTONOMOUS_ENGINE_SELF_TEST_FAILED', 'discovery completion');
  return true;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes('--self-test')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  selfTestAutonomousResearchEngine({ root });
  console.log('AUTONOMOUS_RESEARCH_ENGINE_SELF_TEST_PASS');
}
