import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function fail(message) { throw new Error(`VOLUME_CONTEXT_DESIGN_CONTRACT_INVALID:${message}`); }
function parsePipeRecord(text, prefix, requiredKeys) {
  const raw = String(text || '').trim();
  if (!raw.startsWith(`${prefix}|`)) fail(`${prefix} prefix required`);
  const parts = raw.split('|');
  if (parts[0] !== prefix) fail(`${prefix} prefix malformed`);
  const values = {};
  for (const part of parts.slice(1)) {
    const i = part.indexOf('=');
    if (i <= 0) fail(`${prefix} field malformed: ${part}`);
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key || !value) fail(`${prefix} empty field: ${key || 'missing'}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) fail(`${prefix} duplicate field: ${key}`);
    values[key] = value;
  }
  for (const key of requiredKeys) if (!Object.prototype.hasOwnProperty.call(values, key)) fail(`${prefix} missing field: ${key}`);
  for (const key of Object.keys(values)) if (!requiredKeys.includes(key)) fail(`${prefix} unexpected field: ${key}`);
  return values;
}
function hasBoundedFamily(text) {
  const value = String(text || '').trim();
  if (!value || /^(none|n\/a|na|null)$/i.test(value)) return false;
  return /\[[^\]]+\]/.test(value) || /\.\./.test(value) || /\bfrom\b.+\bto\b/i.test(value) || /\bbetween\b.+\band\b/i.test(value);
}
function unsupportedNarrative(text) {
  const value = String(text || '').toLowerCase();
  const terms = ['profit', 'profitable', 'institutional', 'participant', 'smart money', 'catalyst', 'support', 'resistance'];
  return terms.find(term => value.includes(term)) || null;
}

const PRIMARY = new Set(['MA_FRESH_CROSS_UP', 'PRICE_MA_RECLAIM_UP', 'PRICE_N_HIGH_BREAKOUT']);
const CONTEXT_MODE = new Set(['STATE_ABOVE', 'FRESH_UP_CROSS']);

export function validateVolumeContextDesignWorkProduct(wp) {
  if (!wp || wp.schema !== 'AgentWorkProduct@1.0.0') fail('AgentWorkProduct required');
  if (wp.profitabilityClaim !== false) fail('profitabilityClaim must be false');

  const proposals = (Array.isArray(wp.findings) ? wp.findings : []).filter(x => x?.kind === 'PROPOSAL');
  if (proposals.length !== 3) fail(`exactly 3 PROPOSAL findings required actual=${proposals.length}`);
  const keys = ['hypothesisId', 'primaryFeatureId', 'contextFeatureId', 'contextMode', 'primaryParams', 'contextParams', 'timing', 'entry', 'chart', 'densityRisk', 'distinct'];
  const candidates = proposals.map(x => parsePipeRecord(x.claim, 'CONTEXT_CANDIDATE', keys));
  const ids = new Set();
  const primaryIds = new Set();
  for (const c of candidates) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(c.hypothesisId)) fail(`hypothesisId must be UPPER_SNAKE_ID: ${c.hypothesisId}`);
    if (ids.has(c.hypothesisId)) fail(`duplicate hypothesisId: ${c.hypothesisId}`);
    ids.add(c.hypothesisId);
    if (!PRIMARY.has(c.primaryFeatureId)) fail(`unsupported primaryFeatureId: ${c.primaryFeatureId}`);
    if (primaryIds.has(c.primaryFeatureId)) fail(`primaryFeatureId must be unique across three candidates: ${c.primaryFeatureId}`);
    primaryIds.add(c.primaryFeatureId);
    if (c.contextFeatureId !== 'VOLUME_DENSITY_SHIFT') fail(`contextFeatureId must be VOLUME_DENSITY_SHIFT: ${c.contextFeatureId}`);
    if (!CONTEXT_MODE.has(c.contextMode)) fail(`contextMode must be STATE_ABOVE or FRESH_UP_CROSS: ${c.contextMode}`);
    if (!hasBoundedFamily(c.primaryParams)) fail(`${c.hypothesisId} primaryParams must define bounded family`);
    if (!hasBoundedFamily(c.contextParams)) fail(`${c.hypothesisId} contextParams must define bounded family`);
    if (c.timing !== 'SAME_D') fail(`${c.hypothesisId} timing must be SAME_D`);
    if (c.entry !== 'D+1 open') fail(`${c.hypothesisId} entry must be D+1 open`);
    for (const key of ['chart', 'densityRisk', 'distinct']) if (String(c[key]).trim().length < 3) fail(`${c.hypothesisId} ${key} too short`);
    const bad = unsupportedNarrative(`${c.chart} ${c.distinct}`);
    if (bad) fail(`${c.hypothesisId} unsupported narrative term: ${bad}`);
  }
  if (primaryIds.size !== PRIMARY.size) fail('candidates must cover all three existing chart-ready primary triggers exactly once');

  const summary = parsePipeRecord(wp.summary, 'RANK1_CONTEXT', ['hypothesisId', 'reason']);
  if (!ids.has(summary.hypothesisId)) fail(`RANK1_CONTEXT hypothesisId not among candidates: ${summary.hypothesisId}`);
  const badSummary = unsupportedNarrative(summary.reason);
  if (badSummary) fail(`RANK1_CONTEXT unsupported narrative term: ${badSummary}`);

  if (!Array.isArray(wp.nextActions) || wp.nextActions.length !== 1) fail(`exactly one nextAction required actual=${Array.isArray(wp.nextActions) ? wp.nextActions.length : 'invalid'}`);
  const next = parsePipeRecord(wp.nextActions[0], 'COMPOSITE_DISCOVERY_CONTRACT', ['hypothesisId', 'parameterSearch', 'notes']);
  if (next.hypothesisId !== summary.hypothesisId) fail('COMPOSITE_DISCOVERY_CONTRACT hypothesisId must equal RANK1_CONTEXT');
  if (!hasBoundedFamily(next.parameterSearch)) fail('parameterSearch must define bounded parameter family');
  if (/(acceptance|reject\s+if|pass\s+if|win.?rate|positivepct|negativepct|profit|ranking|gate|gating|>=|<=|%)/i.test(next.notes)) fail('Coordinator-owned performance/gating language leaked into notes');

  return { rank1: summary.hypothesisId, candidates };
}

export function validateVolumeContextDesignResult(result) {
  if (!result || result.schema !== 'AgentResult@1.0.0' || result.status !== 'COMPLETED') fail('AgentResult COMPLETED required');
  if (result.agentId !== 'feature-architect') fail('feature-architect result required');
  return validateVolumeContextDesignWorkProduct(result.workProduct);
}

function selfTest() {
  const good = {
    schema: 'AgentResult@1.0.0', status: 'COMPLETED', agentId: 'feature-architect',
    workProduct: {
      schema: 'AgentWorkProduct@1.0.0', profitabilityClaim: false,
      summary: 'RANK1_CONTEXT|hypothesisId=MA_RECLAIM_WITH_VOLUME_CONTEXT|reason=simple same-day composition with chart traceability',
      findings: [
        { kind: 'PROPOSAL', claim: 'CONTEXT_CANDIDATE|hypothesisId=MA_CROSS_WITH_VOLUME_CONTEXT|primaryFeatureId=MA_FRESH_CROSS_UP|contextFeatureId=VOLUME_DENSITY_SHIFT|contextMode=STATE_ABOVE|primaryParams=fast=[3,20],slow=[10,120]|contextParams=lookback=[15,55],threshold=[0.7,1.1]|timing=SAME_D|entry=D+1 open|chart=MA cross marker plus volume-density overlay|densityRisk=conjunction may reduce event count|distinct=existing MA cross controls timing while volume state is context only' },
        { kind: 'PROPOSAL', claim: 'CONTEXT_CANDIDATE|hypothesisId=MA_RECLAIM_WITH_VOLUME_CONTEXT|primaryFeatureId=PRICE_MA_RECLAIM_UP|contextFeatureId=VOLUME_DENSITY_SHIFT|contextMode=FRESH_UP_CROSS|primaryParams=period=[5,120]|contextParams=lookback=[15,55],threshold=[0.7,1.1]|timing=SAME_D|entry=D+1 open|chart=price reclaim marker plus volume-density crossing overlay|densityRisk=same-day conjunction may be sparse|distinct=price reclaim controls timing and volume crossing supplies independent context' },
        { kind: 'PROPOSAL', claim: 'CONTEXT_CANDIDATE|hypothesisId=HIGH_BREAKOUT_WITH_VOLUME_CONTEXT|primaryFeatureId=PRICE_N_HIGH_BREAKOUT|contextFeatureId=VOLUME_DENSITY_SHIFT|contextMode=STATE_ABOVE|primaryParams=lookback=[5,120]|contextParams=lookback=[15,55],threshold=[0.7,1.1]|timing=SAME_D|entry=D+1 open|chart=rolling-high breakout marker plus volume-density overlay|densityRisk=conjunction may cluster on active dates|distinct=price breakout controls timing and volume state is a separate context condition' },
      ],
      nextActions: ['COMPOSITE_DISCOVERY_CONTRACT|hypothesisId=MA_RECLAIM_WITH_VOLUME_CONTEXT|parameterSearch=period=[5,120],volumeLookback=[15,55],volumeThreshold=[0.7,1.1]|notes=Use deterministic same-day composition and chart overlays'],
    },
  };
  const ok = validateVolumeContextDesignResult(good);
  if (ok.rank1 !== 'MA_RECLAIM_WITH_VOLUME_CONTEXT' || ok.candidates.length !== 3) fail('self-test good result failed');
  const bad = JSON.parse(JSON.stringify(good));
  bad.workProduct.findings[0].claim = bad.workProduct.findings[0].claim.replace('timing=SAME_D', 'timing=RECENT');
  let rejected = false;
  try { validateVolumeContextDesignResult(bad); } catch { rejected = true; }
  if (!rejected) fail('self-test invalid timing was not rejected');
  console.log('VOLUME_CONTEXT_DESIGN_CONTRACT_SELF_TEST_PASS');
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const command = process.argv[2];
  if (command === '--self-test') selfTest();
  else {
    const file = arg('result');
    if (!file) throw new Error('usage: node scripts/verify_volume_context_design_contract.mjs --result <AgentResult.json> | --self-test');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validated = validateVolumeContextDesignResult(result);
    console.log(`VOLUME_CONTEXT_DESIGN_CONTRACT_PASS rank1=${validated.rank1} candidates=${validated.candidates.length}`);
  }
}
