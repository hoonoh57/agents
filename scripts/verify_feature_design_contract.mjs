import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function fail(message) { throw new Error(`FEATURE_DESIGN_CONTRACT_INVALID:${message}`); }

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

function closedStateReason(state) {
  const text = String(state || '');
  const lower = text.toLowerCase();
  if (/\bD(?:-1)?\b/i.test(text)) return 'state must be lag-independent; D/D-1 belongs only in prevTest/currTest';

  const closeMention = /\bclose\b|종가/i.test(text);
  const priceMeanMention = /(sma|ema|moving average|rolling mean|rolling average|mean\s*\(\s*close|avg\s*\(\s*close|average\s*\(\s*close)/i.test(text);
  if (closeMention && priceMeanMention) return 'closed close-versus-price-average semantics encoded in state';

  const highTerms = ['rolling high', 'prior high', 'previous high', 'n-day high', 'n day high', 'max(high', 'rollingmax(high', 'rolling_max(high'];
  if (closeMention && highTerms.some(term => lower.includes(term))) return 'closed close-versus-prior-or-rolling-high semantics encoded in state';

  return null;
}

function validateTransition(featureId, prevTest, currTest) {
  const prev = String(prevTest || '').replace(/\s+/g, ' ').trim();
  const curr = String(currTest || '').replace(/\s+/g, ' ').trim();
  const up = /^D-1 state <= threshold$/i.test(prev) && /^D state > threshold$/i.test(curr);
  const down = /^D-1 state >= threshold$/i.test(prev) && /^D state < threshold$/i.test(curr);
  if (!up && !down) {
    fail(`${featureId} transition must be exactly D-1 state <= threshold -> D state > threshold OR D-1 state >= threshold -> D state < threshold`);
  }
}

function unsupportedNarrativeReason(text) {
  const value = String(text || '').toLowerCase();
  const terms = ['institutional', 'institution', 'participant', 'smart money', 'support', 'resistance', 'catalyst', 'accumulation', 'distribution'];
  return terms.find(term => value.includes(term)) || null;
}

function hasBoundedParameterFamily(text) {
  const value = String(text || '').trim();
  if (!value || /^(none|n\/a|na|null)$/i.test(value)) return false;
  return /\[[^\]]+\]/.test(value) || /\.\./.test(value) || /\bfrom\b.+\bto\b/i.test(value) || /\bbetween\b.+\band\b/i.test(value);
}

export function validateFeatureDesignWorkProduct(wp) {
  if (!wp || wp.schema !== 'AgentWorkProduct@1.0.0') fail('AgentWorkProduct required');
  if (wp.profitabilityClaim !== false) fail('profitabilityClaim must be false');

  const proposals = (Array.isArray(wp.findings) ? wp.findings : []).filter(x => x?.kind === 'PROPOSAL');
  if (proposals.length !== 3) fail(`exactly 3 PROPOSAL findings required actual=${proposals.length}`);

  const candidateKeys = ['featureId', 'family', 'name', 'state', 'prevTest', 'currTest', 'fields', 'params', 'warmup', 'chart', 'densityRisk', 'distinct'];
  const candidates = proposals.map(x => parsePipeRecord(x.claim, 'CANDIDATE', candidateKeys));
  const featureIds = new Set();
  const families = new Set();

  for (const c of candidates) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(c.featureId)) fail(`featureId must be UPPER_SNAKE_ID: ${c.featureId}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(c.family)) fail(`family must be UPPER_SNAKE_FAMILY: ${c.family}`);
    if (featureIds.has(c.featureId)) fail(`duplicate featureId: ${c.featureId}`);
    if (families.has(c.family)) fail(`duplicate family: ${c.family}`);
    featureIds.add(c.featureId);
    families.add(c.family);

    const closed = closedStateReason(c.state);
    if (closed) fail(`${c.featureId}: ${closed}`);
    validateTransition(c.featureId, c.prevTest, c.currTest);

    for (const key of ['name', 'state', 'fields', 'chart', 'densityRisk', 'distinct']) {
      if (String(c[key]).trim().length < 3) fail(`${c.featureId} ${key} is too short`);
    }
    if (!String(c.warmup).trim()) fail(`${c.featureId} warmup is empty`);
    if (!hasBoundedParameterFamily(c.params)) fail(`${c.featureId} params must define a bounded parameter family`);
  }

  const summary = parsePipeRecord(wp.summary, 'RANK1', ['featureId', 'reason']);
  if (!featureIds.has(summary.featureId)) fail(`RANK1 featureId not among candidates: ${summary.featureId}`);
  const narrative = unsupportedNarrativeReason(summary.reason);
  if (narrative) fail(`RANK1 unsupported narrative term: ${narrative}`);

  if (!Array.isArray(wp.nextActions) || wp.nextActions.length !== 1) fail(`exactly one nextAction required actual=${Array.isArray(wp.nextActions) ? wp.nextActions.length : 'invalid'}`);
  const next = parsePipeRecord(wp.nextActions[0], 'DISCOVERY_CONTRACT', ['featureId', 'parameterSearch', 'notes']);
  if (next.featureId !== summary.featureId) fail(`DISCOVERY_CONTRACT featureId must equal RANK1 ${summary.featureId}`);
  if (!hasBoundedParameterFamily(next.parameterSearch)) fail('DISCOVERY_CONTRACT parameterSearch must define a bounded parameter family');
  if (/(threshold|acceptance|reject\s+if|pass\s+if|win.?rate|positivepct|negativepct|ranking|gate|gating|>=|<=|%)/i.test(next.notes)) fail('Coordinator-owned acceptance or parameter-bound language leaked into nextAction notes');

  return { rank1: summary.featureId, candidates };
}

export function validateFeatureDesignResult(result) {
  if (!result || result.schema !== 'AgentResult@1.0.0' || result.status !== 'COMPLETED') fail('AgentResult COMPLETED required');
  if (result.agentId !== 'feature-architect') fail('feature-architect result required');
  return validateFeatureDesignWorkProduct(result.workProduct);
}

function selfTest() {
  const good = {
    schema: 'AgentResult@1.0.0', status: 'COMPLETED', agentId: 'feature-architect',
    workProduct: {
      schema: 'AgentWorkProduct@1.0.0', profitabilityClaim: false,
      summary: 'RANK1|featureId=VOLUME_RATIO_SURGE|reason=chart traceability from available volume data',
      findings: [
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=VOLUME_RATIO_SURGE|family=VOLUME_TRANSITION|name=Volume ratio surge|state=volume divided by rollingMean(volume,N)|prevTest=D-1 state <= threshold|currTest=D state > threshold|fields=volume|params=N=[5,20],threshold=[1.2,3.0]|warmup=N|chart=volume ratio overlay and D marker|densityRisk=may cluster in active regimes|distinct=volume scalar crossing is primary' },
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=RANGE_RATIO_SURGE|family=RANGE_TRANSITION|name=Range ratio surge|state=(high-low) divided by rollingMean(high-low,N)|prevTest=D-1 state <= threshold|currTest=D state > threshold|fields=high,low|params=N=[5,20],threshold=[1.2,3.0]|warmup=1|chart=range ratio overlay and D marker|densityRisk=may cluster after volatility shocks|distinct=range magnitude scalar crossing is primary' },
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=CLOSE_LOCATION_REVERSAL|family=CLOSE_LOCATION_TRANSITION|name=Close location reversal|state=(close-low)/(high-low)|prevTest=D-1 state <= threshold|currTest=D state > threshold|fields=high,low,close|params=threshold=[0.2,0.8]|warmup=2|chart=close-location oscillator and D marker|densityRisk=may be frequent in wide candles|distinct=intrabar close-location crossing is primary' },
      ],
      nextActions: ['DISCOVERY_CONTRACT|featureId=VOLUME_RATIO_SURGE|parameterSearch=N=[5,20],threshold=[1.2,3.0]|notes=Use deterministic state computation and chart crossing markers'],
    },
  };
  const ok = validateFeatureDesignResult(good);
  if (ok.rank1 !== 'VOLUME_RATIO_SURGE' || ok.candidates.length !== 3) fail('self-test good result failed');
  const wpOk = validateFeatureDesignWorkProduct(good.workProduct);
  if (wpOk.rank1 !== 'VOLUME_RATIO_SURGE') fail('self-test work product validation failed');

  const badHigh = JSON.parse(JSON.stringify(good));
  badHigh.workProduct.findings[0].claim = badHigh.workProduct.findings[0].claim.replace('volume divided by rollingMean(volume,N)', 'close minus rolling high N');
  let rejectedHigh = false;
  try { validateFeatureDesignResult(badHigh); } catch { rejectedHigh = true; }
  if (!rejectedHigh) fail('self-test closed high predicate was not rejected');

  const badTransition = JSON.parse(JSON.stringify(good));
  badTransition.workProduct.findings[0].claim = badTransition.workProduct.findings[0].claim.replace('prevTest=D-1 state <= threshold', 'prevTest=D-1 state <= threshold (extra narrative)');
  let rejectedTransition = false;
  try { validateFeatureDesignResult(badTransition); } catch { rejectedTransition = true; }
  if (!rejectedTransition) fail('self-test transition suffix was not rejected');

  const badParams = JSON.parse(JSON.stringify(good));
  badParams.workProduct.findings[0].claim = badParams.workProduct.findings[0].claim.replace('params=N=[5,20],threshold=[1.2,3.0]', 'params=None');
  let rejectedParams = false;
  try { validateFeatureDesignResult(badParams); } catch { rejectedParams = true; }
  if (!rejectedParams) fail('self-test unbounded params were not rejected');

  const badNotes = JSON.parse(JSON.stringify(good));
  badNotes.workProduct.nextActions[0] = badNotes.workProduct.nextActions[0].replace('chart crossing markers', 'chart threshold line');
  let rejectedNotes = false;
  try { validateFeatureDesignResult(badNotes); } catch { rejectedNotes = true; }
  if (!rejectedNotes) fail('self-test nextAction notes leakage was not rejected');

  console.log('FEATURE_DESIGN_CONTRACT_SELF_TEST_PASS');
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const command = process.argv[2];
  if (command === '--self-test') selfTest();
  else {
    const file = arg('result');
    if (!file) throw new Error('usage: node scripts/verify_feature_design_contract.mjs --result <AgentResult.json> | --self-test');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validated = validateFeatureDesignResult(result);
    console.log(`FEATURE_DESIGN_CONTRACT_PASS rank1=${validated.rank1} candidates=${validated.candidates.length}`);
  }
}
