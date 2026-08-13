import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidatesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_candidates.json'), 'utf8'));
const casesDoc = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_cases_v3.json'), 'utf8'));

function readEnv() {
  const out = {};
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
const base = (env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const nowId = () => new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const contains = (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase());
const round2 = n => Math.round(n * 100) / 100;

async function api(pathname, options) {
  const r = await fetch(`${base}${pathname}`, options);
  if (!r.ok) throw new Error(`HTTP_${r.status}:${pathname}`);
  return r.json();
}

async function installed() {
  const d = await api('/api/tags');
  return Array.isArray(d.models) ? d.models : [];
}

function typeMatches(value, schema) {
  if (!schema || !schema.type) return true;
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return true;
}

function contractScore(caseDef, output, parseError) {
  const checks = [];
  checks.push({ key: '$parse', expected: 'valid JSON object', actual: parseError || typeof output, pass: !parseError && output && typeof output === 'object' && !Array.isArray(output) });
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { scorePct: 0, checks };
  }
  const schema = caseDef.responseSchema;
  const required = schema.required || [];
  const actualKeys = Object.keys(output);
  for (const key of required) {
    checks.push({ key, expected: 'required', actual: Object.prototype.hasOwnProperty.call(output, key) ? 'present' : 'missing', pass: Object.prototype.hasOwnProperty.call(output, key) });
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    const extras = actualKeys.filter(k => !allowed.has(k));
    checks.push({ key: '$extraKeys', expected: [], actual: extras, pass: extras.length === 0 });
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) continue;
    const value = output[key];
    checks.push({ key: `${key}:type`, expected: prop.type, actual: Array.isArray(value) ? 'array' : typeof value, pass: typeMatches(value, prop) });
    if (Array.isArray(prop.enum)) checks.push({ key: `${key}:enum`, expected: prop.enum, actual: value, pass: prop.enum.includes(value) });
  }
  const passed = checks.filter(x => x.pass).length;
  return { scorePct: checks.length ? passed / checks.length * 100 : 0, checks };
}

function semanticScore(caseDef, output) {
  const checks = [];
  for (const [key, expected] of Object.entries(caseDef.expected || {})) {
    const actual = output?.[key];
    checks.push({ key, expected, actual, pass: deepEqual(actual, expected) });
  }
  for (const [key, needles] of Object.entries(caseDef.requiredContains || {})) {
    for (const expected of needles) {
      const actual = output?.[key];
      checks.push({ key, expected, actual, pass: contains(actual, expected) });
    }
  }
  for (const [key, needles] of Object.entries(caseDef.forbiddenContains || {})) {
    for (const expected of needles) {
      const actual = output?.[key];
      checks.push({ key, expected: `NOT ${expected}`, actual, pass: !contains(actual, expected) });
    }
  }
  const passed = checks.filter(x => x.pass).length;
  return { scorePct: checks.length ? passed / checks.length * 100 : 0, checks };
}

async function generate(model, caseDef, context) {
  const started = Date.now();
  const d = await api('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      system: 'You are a local research agent under deterministic evaluation. Solve the task correctly, obey the supplied JSON schema, never invent profitability evidence, and never propose broker actions.',
      prompt: caseDef.prompt,
      format: caseDef.responseSchema,
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
  if (casesDoc.schema !== 'LocalModelBenchmarkCases@1.2.0') throw new Error(`unexpected cases schema:${casesDoc.schema}`);
  for (const c of casesDoc.cases) {
    const fixture = { ...(c.expected || {}), rationale: 'fixture' };
    if (c.caseId === 'CODER-CONTRACT-001') fixture.correctedFunction = 'function signal(close:number[], i:number){ return i > 0 && close[i] > close[i-1]; }';
    const contract = contractScore(c, fixture, null);
    const semantic = semanticScore(c, fixture);
    if (contract.scorePct !== 100 || semantic.scorePct !== 100) throw new Error(`self-test failed:${c.caseId}:contract=${contract.scorePct}:semantic=${semantic.scorePct}`);
  }
  console.log(`[model-benchmark-v3] SELF_TEST_PASS candidates=${candidatesDoc.candidates.length} cases=${casesDoc.cases.length} scorer=semantic-contract-v2`);
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
  const rawRuns = [];

  for (const candidate of selected) {
    console.log(`[model-benchmark-v3] MODEL_START ${candidate.model}`);
    const caseResults = [];
    let runtime = null;
    for (const c of casesDoc.cases.filter(x => candidate.roles.includes(x.role))) {
      const g = await generate(candidate.model, c, context);
      runtime ||= await psInfo(candidate.model);
      const contract = contractScore(c, g.parsed, g.parseError);
      const semantic = g.parsed ? semanticScore(c, g.parsed) : { scorePct: 0, checks: [] };
      const quality = semantic.scorePct * 0.8 + contract.scorePct * 0.2;
      const item = {
        caseId: c.caseId,
        role: c.role,
        weight: c.weight,
        semanticScorePct: round2(semantic.scorePct),
        contractScorePct: round2(contract.scorePct),
        qualityScorePct: round2(quality),
        parseError: g.parseError,
        metrics: g.metrics,
        semanticChecks: semantic.checks,
        contractChecks: contract.checks
      };
      caseResults.push(item);
      rawRuns.push({ model: candidate.model, caseId: c.caseId, parsed: g.parsed, raw: g.raw, result: item });
      console.log(`[model-benchmark-v3] CASE_RESULT ${candidate.model} ${c.caseId} semantic=${item.semanticScorePct} contract=${item.contractScorePct} quality=${item.qualityScorePct} tok_s=${item.metrics.outputTokensPerSec?.toFixed?.(2) ?? 'n/a'}`);
      const failed = semantic.checks.filter(x => !x.pass);
      for (const f of failed) console.log(`[model-benchmark-v3]   SEMANTIC_FAIL ${f.key} expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`);
      const contractFailed = contract.checks.filter(x => !x.pass);
      for (const f of contractFailed) console.log(`[model-benchmark-v3]   CONTRACT_FAIL ${f.key} expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`);
      if (failed.length || contractFailed.length || g.parseError) console.log(`[model-benchmark-v3]   PARSED ${JSON.stringify(g.parsed)}`);
    }

    const totalWeight = caseResults.reduce((a, x) => a + x.weight, 0) || 1;
    const weighted = key => caseResults.reduce((a, x) => a + x[key] * x.weight, 0) / totalWeight;
    const speeds = caseResults.map(x => x.metrics.outputTokensPerSec).filter(Number.isFinite);
    const roleScores = {};
    for (const role of [...new Set(caseResults.map(x => x.role))]) {
      const items = caseResults.filter(x => x.role === role);
      const w = items.reduce((a, x) => a + x.weight, 0) || 1;
      roleScores[role] = {
        semantic: round2(items.reduce((a, x) => a + x.semanticScorePct * x.weight, 0) / w),
        contract: round2(items.reduce((a, x) => a + x.contractScorePct * x.weight, 0) / w),
        quality: round2(items.reduce((a, x) => a + x.qualityScorePct * x.weight, 0) / w)
      };
    }
    const summary = {
      model: candidate.model,
      semanticScore: round2(weighted('semanticScorePct')),
      contractScore: round2(weighted('contractScorePct')),
      qualityScore: round2(weighted('qualityScorePct')),
      roleScores,
      avgOutputTokensPerSec: speeds.length ? round2(speeds.reduce((a,b) => a+b,0) / speeds.length) : null,
      actualModelBytes: installedMap.get(candidate.model)?.size ?? null,
      actualQuantization: installedMap.get(candidate.model)?.details?.quantization_level ?? null,
      runtimeSizeVramBytes: runtime?.size_vram ?? null,
      runtimeContextLength: runtime?.context_length ?? null
    };
    summaries.push(summary);
    console.log(`[model-benchmark-v3] MODEL_RESULT ${candidate.model} semantic=${summary.semanticScore} contract=${summary.contractScore} quality=${summary.qualityScore} tok_s=${summary.avgOutputTokensPerSec ?? 'n/a'} vram=${summary.runtimeSizeVramBytes ?? 'n/a'}`);
    await unload(candidate.model);
  }

  const ranking = [...summaries].sort((a,b) => b.qualityScore - a.qualityScore || b.semanticScore - a.semanticScore || (b.avgOutputTokensPerSec || 0) - (a.avgOutputTokensPerSec || 0));
  const out = {
    schema: 'LocalModelBenchmarkResult@1.2.0',
    scorerVersion: 'semantic-contract-v2',
    runId,
    createdAt: new Date().toISOString(),
    observedHardware: hardware(),
    contextTokens: context,
    models: summaries,
    ranking,
    selectionStatus: 'EVIDENCE_ONLY_NOT_PROMOTED'
  };
  const resultPath = path.join(root, 'benchmarks', 'results', `${runId}-semantic-contract-v2.json`);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify(out, null, 2) + '\n');
  const rawDir = path.join(root, 'research-artifacts', 'model-benchmark', runId);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'raw-semantic-contract-v2.json'), JSON.stringify({ schema: 'LocalModelBenchmarkRaw@1.2.0', runId, runs: rawRuns }, null, 2) + '\n');
  console.log(`[model-benchmark-v3] SUMMARY_PATH=${resultPath}`);
  console.log('[model-benchmark-v3] RANKING');
  ranking.forEach((x, i) => console.log(`  ${i+1}. ${x.model} quality=${x.qualityScore} semantic=${x.semanticScore} contract=${x.contractScore} tok_s=${x.avgOutputTokensPerSec ?? 'n/a'}`));
}

try {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'run') await run();
  else throw new Error('usage: node scripts/model_benchmark_v3.mjs <self-test|run> [--models a,b] [--context 4096]');
} catch (e) {
  console.error(`[model-benchmark-v3] ERROR ${String(e?.message || e)}`);
  process.exit(1);
}
