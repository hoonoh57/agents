import fs from 'node:fs';

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
  const actualKeys = Object.keys(values);
  for (const key of requiredKeys) if (!Object.prototype.hasOwnProperty.call(values, key)) fail(`${prefix} missing field: ${key}`);
  for (const key of actualKeys) if (!requiredKeys.includes(key)) fail(`${prefix} unexpected field: ${key}`);
  return values;
}

function closedPredicateReason(t0) {
  const text = String(t0 || '');
  const lower = text.toLowerCase();
  if (/\b(ma\d*|sma\d*|ema\d*|moving average)\b/i.test(text)) return 'MA predicate reused in t0';
  if (lower.includes('ma_fresh_cross_up') || lower.includes('price_ma_reclaim_up') || lower.includes('price_n_high_breakout')) return 'closed feature id reused in t0';
  const highTerms = ['rolling high', 'prior high', 'previous high', 'n-day high', 'n day high', 'd-1 high'];
  if ((lower.includes('close') || lower.includes('종가')) && highTerms.some(term => lower.includes(term))) {
    if (/(>|above|break|cross|exceed|돌파|상향)/i.test(text)) return 'close-above-prior-or-rolling-high predicate reused in t0';
  }
  return null;
}

export function validateFeatureDesignResult(result) {
  if (!result || result.schema !== 'AgentResult@1.0.0' || result.status !== 'COMPLETED') fail('AgentResult COMPLETED required');
  if (result.agentId !== 'feature-architect') fail('feature-architect result required');
  const wp = result.workProduct;
  if (!wp || wp.schema !== 'AgentWorkProduct@1.0.0') fail('AgentWorkProduct required');
  if (wp.profitabilityClaim !== false) fail('profitabilityClaim must be false');

  const proposals = (Array.isArray(wp.findings) ? wp.findings : []).filter(x => x?.kind === 'PROPOSAL');
  if (proposals.length !== 3) fail(`exactly 3 PROPOSAL findings required actual=${proposals.length}`);

  const candidateKeys = ['featureId', 'family', 'name', 't0', 'fields', 'params', 'warmup', 'chart', 'densityRisk', 'distinct'];
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

    if (!/D-1/i.test(c.t0)) fail(`${c.featureId} t0 must explicitly include D-1`);
    const withoutPrev = c.t0.replace(/D-1/gi, '');
    if (!/\bD\b/i.test(withoutPrev)) fail(`${c.featureId} t0 must explicitly include D`);
    const closed = closedPredicateReason(c.t0);
    if (closed) fail(`${c.featureId}: ${closed}`);
    for (const key of ['fields', 'params', 'warmup', 'chart', 'densityRisk', 'distinct']) {
      if (String(c[key]).trim().length < 3) fail(`${c.featureId} ${key} is too short`);
    }
  }

  const summary = parsePipeRecord(wp.summary, 'RANK1', ['featureId', 'reason']);
  if (!featureIds.has(summary.featureId)) fail(`RANK1 featureId not among candidates: ${summary.featureId}`);

  if (!Array.isArray(wp.nextActions) || wp.nextActions.length !== 1) fail(`exactly one nextAction required actual=${Array.isArray(wp.nextActions) ? wp.nextActions.length : 'invalid'}`);
  const next = parsePipeRecord(wp.nextActions[0], 'DISCOVERY_CONTRACT', ['featureId', 'parameterSearch', 'notes']);
  if (next.featureId !== summary.featureId) fail(`DISCOVERY_CONTRACT featureId must equal RANK1 ${summary.featureId}`);
  if (/(threshold|acceptance|reject if|pass if|win.?rate|positivepct|negativepct|>=|<=|%)/i.test(next.notes)) fail('Coordinator-owned acceptance threshold leaked into nextAction notes');

  return { rank1: summary.featureId, candidates };
}

function selfTest() {
  const good = {
    schema: 'AgentResult@1.0.0', status: 'COMPLETED', agentId: 'feature-architect',
    workProduct: {
      schema: 'AgentWorkProduct@1.0.0', profitabilityClaim: false,
      summary: 'RANK1|featureId=REVERSAL_A|reason=minimal causal transition',
      findings: [
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=REVERSAL_A|family=REVERSAL|name=A|t0=D-1 closes weak and D closes strong after an intrabar reversal|fields=open,high,low,close|params=one bounded lookback|warmup=2 bars|chart=marker on D and reference line|densityRisk=may be frequent|distinct=no MA or high-breakout predicate' },
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=GAP_B|family=GAP_REVERSAL|name=B|t0=D-1 establishes reference close and D opens away then closes back through the reference zone|fields=open,close|params=bounded gap magnitude family|warmup=2 bars|chart=gap zone plus D marker|densityRisk=may be sparse|distinct=gap transition is primary' },
        { kind: 'PROPOSAL', sourceInputIds: ['x'], claim: 'CANDIDATE|featureId=RANGE_C|family=RANGE_TRANSITION|name=C|t0=D-1 has compressed range and D expands range with close-location transition|fields=open,high,low,close|params=bounded range window|warmup=window plus 1|chart=range overlay and D marker|densityRisk=depends on compression window|distinct=range-state transition is primary' },
      ],
      nextActions: ['DISCOVERY_CONTRACT|featureId=REVERSAL_A|parameterSearch=bounded parameter family|notes=Coordinator supplies ranking and gate'],
    },
  };
  const ok = validateFeatureDesignResult(good);
  if (ok.rank1 !== 'REVERSAL_A' || ok.candidates.length !== 3) fail('self-test good result failed');
  const bad = JSON.parse(JSON.stringify(good));
  bad.workProduct.findings[0].claim = bad.workProduct.findings[0].claim.replace('D-1 closes weak and D closes strong after an intrabar reversal', 'D-1 close is below MA20 and D close crosses above MA20');
  let rejected = false;
  try { validateFeatureDesignResult(bad); } catch { rejected = true; }
  if (!rejected) fail('self-test closed predicate was not rejected');
  console.log('FEATURE_DESIGN_CONTRACT_SELF_TEST_PASS');
}

const command = process.argv[2];
if (command === '--self-test') selfTest();
else {
  const file = arg('result');
  if (!file) throw new Error('usage: node scripts/verify_feature_design_contract.mjs --result <AgentResult.json> | --self-test');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validated = validateFeatureDesignResult(result);
  console.log(`FEATURE_DESIGN_CONTRACT_PASS rank1=${validated.rank1} candidates=${validated.candidates.length}`);
}
