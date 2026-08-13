import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_candidates.json'), 'utf8'));
const casesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_cases.json'), 'utf8'));

function envFile() {
  const out = {};
  const f = path.join(root, '.env');
  if (!fs.existsSync(f)) return out;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...envFile(), ...process.env };
const base = (env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const contains = (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase());
const nowId = () => new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

function score(caseDef, output) {
  const checks = [];
  for (const [key, expected] of Object.entries(caseDef.required || {})) {
    const actual = output?.[key];
    checks.push({ key, type: 'exact', expected, actual, pass: deepEqual(actual, expected) });
  }
  for (const [key, expected] of Object.entries(caseDef.requiredScalar || {})) {
    const actual = output?.[key];
    checks.push({ key, type: 'scalar', expected, actual, pass: actual === expected });
  }
  for (const [key, needles] of Object.entries(caseDef.requiredContains || {})) {
    for (const expected of needles) {
      const actual = output?.[key];
      checks.push({ key, type: 'contains', expected, actual, pass: contains(actual, expected) });
    }
  }
  for (const [key, needles] of Object.entries(caseDef.forbiddenContains || {})) {
    for (const expected of needles) {
      const actual = output?.[key];
      checks.push({ key, type: 'forbidden', expected, actual, pass: !contains(actual, expected) });
    }
  }
  const passed = checks.filter(x => x.pass).length;
  return { scorePct: checks.length ? passed / checks.length * 100 : 0, passed, total: checks.length, checks };
}

async function api(pathname, options) {
  const r = await fetch(`${base}${pathname}`, options);
  if (!r.ok) throw new Error(`HTTP_${r.status}:${pathname}`);
  return r.json();
}

async function installed() {
  const d = await api('/api/tags');
  return Array.isArray(d.models) ? d.models : [];
}

async function generate(model, prompt, context) {
  const started = Date.now();
  const d = await api('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      system: 'You are a deterministic local research agent benchmark. Follow the JSON contract exactly. Do not invent profitability evidence or broker actions.',
      prompt,
      format: 'json',
      stream: false,
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: context }
    })
  });
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(d.response); } catch (e) { parseError = String(e?.message || e); }
  const evalSec = Number(d.eval_duration || 0) / 1e9;
  return {
    parsed,
    raw: d.response,
    parseError,
    metrics: {
      wallMs: Date.now() - started,
      loadMs: Number(d.load_duration || 0) / 1e6,
      outputTokens: Number(d.eval_count || 0),
      outputTokensPerSec: evalSec > 0 ? Number(d.eval_count || 0) / evalSec : null,
      doneReason: d.done_reason || null
    }
  };
}

async function psInfo(model) {
  try {
    const d = await api('/api/ps');
    return (d.models || []).find(x => x.name === model || x.model === model) || null;
  } catch { return null; }
}

async function unload(model) {
  try {
    await api('/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
    });
  } catch {}
}

function hardware() {
  let gpu = null;
  let ollamaVersion = null;
  try { gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim(); } catch {}
  try { ollamaVersion = execFileSync('ollama', ['--version'], { encoding: 'utf8' }).trim(); } catch {}
  return { gpu, ollamaVersion, nodeVersion: process.version, platform: process.platform, arch: process.arch };
}

function selfTest() {
  if (casesDoc.schema !== 'LocalModelBenchmarkCases@1.1.0') throw new Error(`unexpected cases schema:${casesDoc.schema}`);
  const fixtures = {
    'FAST-JSON-CRUD-001': { sortedIds: ['EXP-1','EXP-2','EXP-3'], uniqueCount: 3, rejectedIds: ['EXP-3'], contractCode: 'RESEARCH_MEMORY_NORMALIZED' },
    'REASON-CAUSAL-001': { causalErrorCode: 'TRIGGER_FILTER_CONFLATION', correctionCode: 'SEPARATE_TRIGGER_AND_FILTER', triggerEventCode: 'MA5_CROSS_UP_MA20_ON_D', filterCode: 'RSI_GT_50_AT_TRIGGER', falseSignalDay: 'D+1', executionReference: 'D+1_OPEN', profitabilityClaim: false },
    'REASON-INCREMENTAL-001': { retainedWinners: 32, removedWinners: 8, removedLosers: 30, remainingEvents: 62, winnerRetentionPct: 80, loserRemovalPct: 50, nextValidationCode: 'UNSEEN_CHRONOLOGICAL_OOS', profitabilityClaim: false },
    'CODER-CONTRACT-001': { defectCode: 'FUTURE_BAR_ACCESS', correctedFunction: 'function signal(close:number[], i:number){ return close[i] > close[i-1]; }', invariantCode: 'NO_FUTURE_BAR_ACCESS', futureReferenceDetected: true, correctedUsesFuture: false }
  };
  for (const c of casesDoc.cases) {
    const s = score(c, fixtures[c.caseId]);
    if (s.scorePct !== 100) throw new Error(`self-test failed:${c.caseId}:${s.scorePct}`);
  }
  console.log(`[model-benchmark-v2] SELF_TEST_PASS candidates=${candidatesDoc.candidates.length} cases=${casesDoc.cases.length} scorer=semantic-v1`);
}

async function run() {
  const context = Math.max(1024, Number(arg('context', '4096')));
  const names = String(arg('models', 'gemma4:12b')).split(',').map(x => x.trim()).filter(Boolean);
  const candidateMap = new Map(candidatesDoc.candidates.map(x => [x.model, x]));
  const selected = names.map(n => candidateMap.get(n));
  if (selected.some(x => !x)) throw new Error('unregistered model in --models');
  const installedModels = await installed();
  const installedMap = new Map(installedModels.map(x => [x.name, x]));
  const missing = names.filter(n => !installedMap.has(n));
  if (missing.length) throw new Error(`MODEL_NOT_INSTALLED:${missing.join(',')}`);

  const runId = nowId();
  const summaries = [];
  const raw = [];
  for (const candidate of selected) {
    console.log(`[model-benchmark-v2] MODEL_START ${candidate.model}`);
    const caseResults = [];
    let runtime = null;
    for (const c of casesDoc.cases.filter(x => candidate.roles.includes(x.role))) {
      const g = await generate(candidate.model, c.prompt, context);
      runtime ||= await psInfo(candidate.model);
      const s = g.parsed ? score(c, g.parsed) : { scorePct: 0, passed: 0, total: 1, checks: [] };
      const item = { caseId: c.caseId, role: c.role, weight: c.weight, scorePct: Math.round(s.scorePct * 100) / 100, parseError: g.parseError, metrics: g.metrics, checks: s.checks };
      caseResults.push(item);
      raw.push({ model: candidate.model, caseId: c.caseId, parsed: g.parsed, raw: g.raw, result: item });
      console.log(`[model-benchmark-v2] CASE_RESULT ${candidate.model} ${c.caseId} score=${item.scorePct} tok_s=${item.metrics.outputTokensPerSec?.toFixed?.(2) ?? 'n/a'}`);
      for (const f of s.checks.filter(x => !x.pass)) console.log(`[model-benchmark-v2]   FAIL ${f.key} expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`);
      if (g.parseError) console.log(`[model-benchmark-v2]   PARSE_ERROR ${g.parseError}`);
    }
    const weight = caseResults.reduce((a, x) => a + x.weight, 0) || 1;
    const quality = caseResults.reduce((a, x) => a + x.scorePct * x.weight, 0) / weight;
    const speeds = caseResults.map(x => x.metrics.outputTokensPerSec).filter(Number.isFinite);
    const roleScores = {};
    for (const role of [...new Set(caseResults.map(x => x.role))]) {
      const items = caseResults.filter(x => x.role === role);
      const w = items.reduce((a, x) => a + x.weight, 0) || 1;
      roleScores[role] = Math.round(items.reduce((a, x) => a + x.scorePct * x.weight, 0) / w * 100) / 100;
    }
    const summary = {
      model: candidate.model,
      qualityScore: Math.round(quality * 100) / 100,
      roleScores,
      structuredOutputPassRate: Math.round(caseResults.filter(x => !x.parseError).length / Math.max(1, caseResults.length) * 10000) / 100,
      avgOutputTokensPerSec: speeds.length ? Math.round(speeds.reduce((a,b) => a+b,0) / speeds.length * 100) / 100 : null,
      actualModelBytes: installedMap.get(candidate.model)?.size ?? null,
      actualQuantization: installedMap.get(candidate.model)?.details?.quantization_level ?? null,
      runtimeSizeVramBytes: runtime?.size_vram ?? null,
      runtimeContextLength: runtime?.context_length ?? null
    };
    summaries.push(summary);
    console.log(`[model-benchmark-v2] MODEL_RESULT ${candidate.model} quality=${summary.qualityScore} tok_s=${summary.avgOutputTokensPerSec ?? 'n/a'} vram=${summary.runtimeSizeVramBytes ?? 'n/a'}`);
    await unload(candidate.model);
  }

  const ranking = [...summaries].sort((a,b) => b.qualityScore - a.qualityScore || (b.avgOutputTokensPerSec || 0) - (a.avgOutputTokensPerSec || 0));
  const out = { schema: 'LocalModelBenchmarkResult@1.1.0', scorerVersion: 'semantic-v1', runId, createdAt: new Date().toISOString(), observedHardware: hardware(), contextTokens: context, models: summaries, ranking, selectionStatus: 'EVIDENCE_ONLY_NOT_PROMOTED' };
  const resultPath = path.join(root, 'benchmarks', 'results', `${runId}-semantic-v1.json`);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(out, null, 2) + '\n');
  const rawDir = path.join(root, 'research-artifacts', 'model-benchmark', runId);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'raw-semantic-v1.json'), JSON.stringify({ schema: 'LocalModelBenchmarkRaw@1.1.0', runId, runs: raw }, null, 2) + '\n');
  console.log(`[model-benchmark-v2] SUMMARY_PATH=${resultPath}`);
  console.log('[model-benchmark-v2] RANKING');
  ranking.forEach((x, i) => console.log(`  ${i+1}. ${x.model} quality=${x.qualityScore} tok_s=${x.avgOutputTokensPerSec ?? 'n/a'}`));
}

try {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'run') await run();
  else throw new Error('usage: node scripts/model_benchmark_v2.mjs <self-test|run> [--models a,b] [--context 4096]');
} catch (e) {
  console.error(`[model-benchmark-v2] ERROR ${String(e?.message || e)}`);
  process.exit(1);
}
