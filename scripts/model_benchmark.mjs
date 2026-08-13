import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_candidates.json'), 'utf8'));
const casesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_cases.json'), 'utf8'));

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...readEnvFile(path.join(root, '.env')), ...process.env };
const baseUrl = (env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function nowId() { return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function getValue(obj, key) { return obj?.[key]; }
function containsText(value, needle) { return String(value ?? '').toLowerCase().includes(String(needle).toLowerCase()); }

function scoreOutput(caseDef, output) {
  const checks = [];
  for (const [key, expected] of Object.entries(caseDef.required || {})) {
    const actual = getValue(output, key);
    checks.push({ type: 'exact', key, pass: deepEqual(actual, expected), expected, actual });
  }
  for (const [key, expected] of Object.entries(caseDef.requiredScalar || {})) {
    const actual = getValue(output, key);
    checks.push({ type: 'scalar', key, pass: actual === expected, expected, actual });
  }
  for (const [key, needles] of Object.entries(caseDef.requiredContains || {})) {
    const actual = getValue(output, key);
    for (const needle of needles) checks.push({ type: 'contains', key, pass: containsText(actual, needle), expected: needle, actual });
  }
  for (const [key, needles] of Object.entries(caseDef.forbiddenContains || {})) {
    const actual = getValue(output, key);
    for (const needle of needles) checks.push({ type: 'forbidden', key, pass: !containsText(actual, needle), expected: `NOT ${needle}`, actual });
  }
  const passCount = checks.filter(x => x.pass).length;
  const total = checks.length || 1;
  return { scorePct: (passCount / total) * 100, passCount, total, checks };
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return await response.json();
}

async function listInstalled() {
  const doc = await getJson(`${baseUrl}/api/tags`);
  return Array.isArray(doc.models) ? doc.models : [];
}

async function psInfo(model) {
  try {
    const doc = await getJson(`${baseUrl}/api/ps`);
    return (doc.models || []).find(x => x.name === model || x.model === model) || null;
  } catch { return null; }
}

function localHardware() {
  let gpu = null;
  let ollamaVersion = null;
  try {
    gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim();
  } catch {}
  try { ollamaVersion = execFileSync('ollama', ['--version'], { encoding: 'utf8' }).trim(); } catch {}
  return { gpu, ollamaVersion, nodeVersion: process.version, platform: process.platform, arch: process.arch };
}

async function generate(model, prompt, contextTokens) {
  const started = Date.now();
  const body = await getJson(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      system: 'You are a local research agent under deterministic evaluation. Follow the requested JSON contract exactly. Never invent profitability evidence or broker actions.',
      prompt,
      format: 'json',
      stream: false,
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: contextTokens }
    })
  });
  const wallMs = Date.now() - started;
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(body.response); } catch (error) { parseError = String(error?.message || error); }
  const evalSeconds = Number(body.eval_duration || 0) / 1e9;
  const promptSeconds = Number(body.prompt_eval_duration || 0) / 1e9;
  return {
    parsed,
    parseError,
    rawResponse: body.response,
    metrics: {
      wallMs,
      totalMs: Number(body.total_duration || 0) / 1e6,
      loadMs: Number(body.load_duration || 0) / 1e6,
      promptTokens: Number(body.prompt_eval_count || 0),
      promptTokensPerSec: promptSeconds > 0 ? Number(body.prompt_eval_count || 0) / promptSeconds : null,
      outputTokens: Number(body.eval_count || 0),
      outputTokensPerSec: evalSeconds > 0 ? Number(body.eval_count || 0) / evalSeconds : null,
      doneReason: body.done_reason || null
    }
  };
}

async function unload(model) {
  try {
    await getJson(`${baseUrl}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
    });
  } catch {}
}

function summarizeModel(candidate, caseResults, installedMeta, runtimePs) {
  const weighted = caseResults.reduce((s, r) => s + r.scorePct * r.weight, 0);
  const weights = caseResults.reduce((s, r) => s + r.weight, 0) || 1;
  const qualityScore = weighted / weights;
  const roleMap = {};
  for (const result of caseResults) {
    roleMap[result.role] ||= [];
    roleMap[result.role].push(result);
  }
  const roleScores = Object.fromEntries(Object.entries(roleMap).map(([role, items]) => {
    const sum = items.reduce((s, x) => s + x.scorePct * x.weight, 0);
    const w = items.reduce((s, x) => s + x.weight, 0) || 1;
    return [role, Math.round((sum / w) * 100) / 100];
  }));
  const speeds = caseResults.map(x => x.metrics.outputTokensPerSec).filter(Number.isFinite);
  return {
    model: candidate.model,
    tier: candidate.tier,
    advertisedRoles: candidate.roles,
    qualityScore: Math.round(qualityScore * 100) / 100,
    roleScores,
    structuredOutputPassRate: Math.round((caseResults.filter(x => !x.parseError).length / Math.max(1, caseResults.length)) * 10000) / 100,
    avgOutputTokensPerSec: speeds.length ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 100) / 100 : null,
    actualModelBytes: installedMeta?.size ?? null,
    actualDigest: installedMeta?.digest ?? null,
    actualQuantization: installedMeta?.details?.quantization_level ?? null,
    runtimeSizeVramBytes: runtimePs?.size_vram ?? null,
    runtimeContextLength: runtimePs?.context_length ?? null,
    caseCount: caseResults.length
  };
}

async function doctor() {
  console.log(`[model-benchmark] base=${baseUrl}`);
  const models = await listInstalled();
  console.log(`[model-benchmark] installed=${models.length}`);
  for (const m of models) console.log(`  ${m.name} size=${m.size ?? '?'} quant=${m.details?.quantization_level ?? '?'}`);
  console.log(JSON.stringify(localHardware(), null, 2));
}

function selfTest() {
  if (candidatesDoc.schema !== 'LocalModelBenchmarkCandidates@1.0.0') throw new Error('invalid candidate schema');
  if (casesDoc.schema !== 'LocalModelBenchmarkCases@1.0.0') throw new Error('invalid cases schema');
  if (!Array.isArray(candidatesDoc.candidates) || candidatesDoc.candidates.length < 2) throw new Error('candidate list too small');
  if (!Array.isArray(casesDoc.cases) || casesDoc.cases.length < 4) throw new Error('case list too small');
  const fast = casesDoc.cases.find(x => x.caseId === 'FAST-JSON-CRUD-001');
  const perfect = scoreOutput(fast, { sortedIds: ['EXP-1','EXP-2','EXP-3'], uniqueCount: 3, rejectedIds: ['EXP-3'] });
  if (perfect.scorePct !== 100) throw new Error('scorer self-test failed');
  console.log(`[model-benchmark] SELF_TEST_PASS candidates=${candidatesDoc.candidates.length} cases=${casesDoc.cases.length}`);
}

async function run() {
  const contextTokens = Math.max(1024, Number(arg('context', String(candidatesDoc.policy.defaultContextTokens || 4096))));
  const modelArg = arg('models');
  const selectedNames = modelArg
    ? modelArg.split(',').map(x => x.trim()).filter(Boolean)
    : candidatesDoc.candidates.filter(x => x.tier === 'CORE').map(x => x.model);
  const selected = selectedNames.map(name => candidatesDoc.candidates.find(x => x.model === name)).filter(Boolean);
  if (selected.length !== selectedNames.length) throw new Error('one or more --models are not registered candidates');

  const installed = await listInstalled();
  const installedMap = new Map(installed.map(x => [x.name, x]));
  const missing = selectedNames.filter(x => !installedMap.has(x));
  if (missing.length) throw new Error(`MODEL_NOT_INSTALLED:${missing.join(',')}`);

  const runId = nowId();
  const rawDir = path.join(root, 'research-artifacts', 'model-benchmark', runId);
  const summaryPath = path.join(root, 'benchmarks', 'results', `${runId}.json`);
  const hardware = localHardware();
  const modelSummaries = [];
  const rawRuns = [];

  for (const candidate of selected) {
    console.log(`[model-benchmark] MODEL_START ${candidate.model}`);
    const results = [];
    let runtimePs = null;
    for (const caseDef of casesDoc.cases.filter(x => candidate.roles.includes(x.role))) {
      console.log(`[model-benchmark] CASE ${candidate.model} ${caseDef.caseId}`);
      const generated = await generate(candidate.model, caseDef.prompt, contextTokens);
      runtimePs ||= await psInfo(candidate.model);
      const scored = generated.parsed ? scoreOutput(caseDef, generated.parsed) : { scorePct: 0, passCount: 0, total: 1, checks: [] };
      const result = {
        caseId: caseDef.caseId,
        role: caseDef.role,
        weight: caseDef.weight,
        scorePct: Math.round(scored.scorePct * 100) / 100,
        parseError: generated.parseError,
        checks: scored.checks,
        metrics: generated.metrics
      };
      results.push(result);
      rawRuns.push({ model: candidate.model, caseId: caseDef.caseId, output: generated.rawResponse, parsed: generated.parsed, result });
      console.log(`[model-benchmark] CASE_RESULT ${candidate.model} ${caseDef.caseId} score=${result.scorePct} tok_s=${result.metrics.outputTokensPerSec?.toFixed?.(2) ?? 'n/a'}`);
    }
    const summary = summarizeModel(candidate, results, installedMap.get(candidate.model), runtimePs);
    modelSummaries.push(summary);
    console.log(`[model-benchmark] MODEL_RESULT ${candidate.model} quality=${summary.qualityScore} tok_s=${summary.avgOutputTokensPerSec ?? 'n/a'} vram=${summary.runtimeSizeVramBytes ?? 'n/a'}`);
    await unload(candidate.model);
  }

  const ranking = [...modelSummaries].sort((a, b) => (b.qualityScore - a.qualityScore) || ((b.avgOutputTokensPerSec || 0) - (a.avgOutputTokensPerSec || 0)));
  const summary = {
    schema: 'LocalModelBenchmarkResult@1.0.0',
    runId,
    createdAt: new Date().toISOString(),
    hardwareTarget: candidatesDoc.hardwareTarget,
    observedHardware: hardware,
    contextTokens,
    models: modelSummaries,
    ranking: ranking.map((x, i) => ({ rank: i + 1, model: x.model, qualityScore: x.qualityScore, avgOutputTokensPerSec: x.avgOutputTokensPerSec, roleScores: x.roleScores })),
    selectionStatus: 'EVIDENCE_ONLY_NOT_PROMOTED',
    note: 'Do not assign LOCAL_* roles from one run alone. Repeat and add Explorer/vision/code-validation workloads before promotion.'
  };
  writeJson(path.join(rawDir, 'raw.json'), { schema: 'LocalModelBenchmarkRaw@1.0.0', runId, runs: rawRuns });
  writeJson(summaryPath, summary);
  console.log(`[model-benchmark] SUMMARY_PATH=${summaryPath}`);
  console.log('[model-benchmark] RANKING');
  for (const x of summary.ranking) console.log(`  ${x.rank}. ${x.model} quality=${x.qualityScore} tok_s=${x.avgOutputTokensPerSec ?? 'n/a'}`);
}

const command = process.argv[2];
try {
  if (command === 'self-test') selfTest();
  else if (command === 'doctor') await doctor();
  else if (command === 'run') await run();
  else throw new Error('usage: node scripts/model_benchmark.mjs <self-test|doctor|run> [--models a,b] [--context 4096]');
} catch (error) {
  console.error(`[model-benchmark] ERROR ${String(error?.message || error)}`);
  process.exit(1);
}
