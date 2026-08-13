import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const baseUrl = (env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const defaultTarget = env.KIWOOM_AUTOTRADE_TEMPLATE_DIR || 'E:\\2026\\opus\\typescript\\kiwoom-autotrade-template';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function round2(n) { return Math.round(n * 100) / 100; }
function exact(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_'); }
function git(target, ...args) { return execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function unload(model) { spawnSync('ollama', ['stop', model], { stdio: 'ignore', windowsHide: true }); }
function read(target, rel) { return fs.readFileSync(path.join(target, rel), 'utf8'); }
function excerpt(text, needle, radius = 1800) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`missing excerpt needle: ${needle}`);
  return text.slice(Math.max(0, i - radius), Math.min(text.length, i + needle.length + radius));
}

function parseOneJson(raw) {
  const text = String(raw ?? '').trim();
  try { return { value: JSON.parse(text), strict: true, recovered: false, trailing: 0 }; } catch {}
  const start = text.indexOf('{');
  if (start < 0) return { value: null, strict: false, recovered: false, trailing: text.length };
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) {
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        const trailing = text.slice(0, start).trim().length + text.slice(i + 1).trim().length;
        return { value, strict: trailing === 0, recovered: true, trailing };
      } catch { break; }
    }
  }
  return { value: null, strict: false, recovered: false, trailing: text.length };
}

function typeOk(value, spec) {
  if (spec.type === 'string') return typeof value === 'string';
  if (spec.type === 'boolean') return typeof value === 'boolean';
  if (spec.type === 'integer') return Number.isInteger(value);
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (spec.type === 'array') return Array.isArray(value);
  return true;
}
function contractScore(schema, parsed) {
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return 0;
  const checks = [parsed.strict];
  for (const key of schema.required || []) checks.push(Object.hasOwn(parsed.value, key));
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    checks.push(Object.keys(parsed.value).every(key => allowed.has(key)));
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(parsed.value, key)) continue;
    checks.push(typeOk(parsed.value[key], spec));
    if (spec.enum) checks.push(spec.enum.includes(parsed.value[key]));
  }
  return checks.length ? checks.filter(Boolean).length / checks.length * 100 : 0;
}

async function ask(model, prompt, schema, options) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Analyze only the supplied repository evidence. Return exactly one concise JSON object matching the schema. No markdown. Do not claim profitability.' },
        { role: 'user', content: `${prompt}\n\nJSON SCHEMA:\n${JSON.stringify(schema)}` }
      ],
      format: schema,
      think: false,
      stream: false,
      keep_alive: '10m',
      options: { temperature: 0, num_ctx: options.context, num_predict: options.maxOutputTokens }
    })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP_${response.status}:${raw.slice(0, 1000)}`);
  const body = JSON.parse(raw);
  const evalSeconds = Number(body.eval_duration || 0) / 1e9;
  return {
    parsed: parseOneJson(body?.message?.content ?? ''),
    wallSeconds: (Date.now() - started) / 1000,
    outputTokens: Number(body.eval_count || 0),
    tokensPerSecond: evalSeconds > 0 ? Number(body.eval_count || 0) / evalSeconds : null,
    loadSeconds: Number(body.load_duration || 0) / 1e9,
    doneReason: body.done_reason || null,
  };
}

async function modelResidency(model) {
  try {
    const r = await fetch(`${baseUrl}/api/ps`);
    if (!r.ok) return null;
    const body = await r.json();
    const row = (body.models || []).find(x => x.name === model || x.model === model);
    if (!row) return null;
    return { size: row.size ?? null, sizeVram: row.size_vram ?? null, contextLength: row.context_length ?? null };
  } catch { return null; }
}

function explorerTask(target) {
  const catalog = read(target, 'template/feature-packs/swing-research/ProfitFeatureCatalog.ts');
  const explorer = read(target, 'template/feature-packs/swing-research/ProfitFeatureExplorer.ts');
  const integration = read(target, 'tests/profit_feature_explorer_integration.test.mjs');
  const prompt = `REAL PROJECT TASK EXPLORER-CONTRACT-001\nRecover the exact fail-closed Explorer contract from these current repository excerpts.\n\n--- ProfitFeatureCatalog.ts ---\n${catalog}\n\n--- ProfitFeatureExplorer.ts excerpt ---\n${excerpt(explorer, 'export interface ProfitFeatureResearchAsset', 1200)}\n\n--- integration test P14-PFX-001 ---\n${excerpt(integration, "P14-PFX-001", 1300)}\n\n--- integration test P14-PFX-008 ---\n${excerpt(integration, "P14-PFX-008", 1200)}\nReturn only the requested facts.`;
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['featureRole','readyFeatureIds','chartReadyGroup','ideaImplementationFeatureId','frozenStatus','profitabilityClaim','brokerActionAllowed'],
    properties: {
      featureRole: { type: 'string', enum: ['TRIGGER','FILTER','UNKNOWN'] },
      readyFeatureIds: { type: 'array', items: { type: 'string' } },
      chartReadyGroup: { type: 'string' },
      ideaImplementationFeatureId: { type: ['string','null'] },
      frozenStatus: { type: 'string' },
      profitabilityClaim: { type: 'boolean' },
      brokerActionAllowed: { type: 'boolean' }
    }
  };
  const expected = {
    featureRole: 'TRIGGER',
    readyFeatureIds: ['MA_FRESH_CROSS_UP','PRICE_MA_RECLAIM_UP','PRICE_N_HIGH_BREAKOUT'],
    chartReadyGroup: 'Chart-ready Probes',
    ideaImplementationFeatureId: null,
    frozenStatus: 'FROZEN_RESEARCH',
    profitabilityClaim: false,
    brokerActionAllowed: false,
  };
  return { id: 'EXPLORER-CONTRACT-001', weight: 1, prompt, schema, score(output) {
    const checks = Object.entries(expected).map(([k,v]) => exact(output?.[k], v));
    return checks.filter(Boolean).length / checks.length * 100;
  }};
}

function causalityTask(target) {
  const source = read(target, 'src/profit_feature_foundry.mjs');
  const test = read(target, 'tests/profit_feature_foundry_live_logic.test.mjs');
  const prompt = `REAL PROJECT TASK RESEARCH-CAUSALITY-001\nRead the actual Foundry implementation and live regression test. Recover the causal trading semantics and sparse-validation conclusion. For projectedValidationN calculate 11 / 330 * 144. Do not make a profitability claim.\n\n--- buildMaFeatureObservations excerpt ---\n${excerpt(source, 'An ordering state is context only', 1900)}\n\n--- projectedValidationSampleCount excerpt ---\n${excerpt(source, 'export function projectedValidationSampleCount', 900)}\n\n--- live regression test ---\n${test}`;
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['orderingStateRole','trigger','decisionReference','entryReference','projectedValidationN','sparseEligible','minimumValidationN','profitabilityClaim'],
    properties: {
      orderingStateRole: { type: 'string', enum: ['CONTEXT_ONLY','TRIGGER','UNKNOWN'] },
      trigger: { type: 'string', enum: ['SHORT_CROSS_UP_MEDIUM','STATE_PERSISTENCE','UNKNOWN'] },
      decisionReference: { type: 'string', enum: ['COMPLETED_D','D_PLUS_1','UNKNOWN'] },
      entryReference: { type: 'string', enum: ['D_PLUS_1_OPEN','D_CLOSE','UNKNOWN'] },
      projectedValidationN: { type: 'number' },
      sparseEligible: { type: 'boolean' },
      minimumValidationN: { type: 'integer' },
      profitabilityClaim: { type: 'boolean' }
    }
  };
  return { id: 'RESEARCH-CAUSALITY-001', weight: 1, prompt, schema, score(o) {
    const checks = [
      o?.orderingStateRole === 'CONTEXT_ONLY', o?.trigger === 'SHORT_CROSS_UP_MEDIUM',
      o?.decisionReference === 'COMPLETED_D', o?.entryReference === 'D_PLUS_1_OPEN',
      Number.isFinite(o?.projectedValidationN) && Math.abs(o.projectedValidationN - 4.8) < 0.02,
      o?.sparseEligible === false, o?.minimumValidationN === 8, o?.profitabilityClaim === false,
    ];
    return checks.filter(Boolean).length / checks.length * 100;
  }};
}

async function codingTask(model, target, targetHead, runDir, options) {
  const id = 'CODER-REPAIR-001';
  const worktree = path.join(runDir, safeName(model));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const good = "else if (baselineComparable && !improvesBaseline) oosReason = 'NO_BASELINE_IMPROVEMENT';";
  const bad = "else if (!improvesBaseline) oosReason = 'NO_BASELINE_IMPROVEMENT';";
  try {
    git(target, 'worktree', 'add', '--detach', worktree, targetHead);
    const rel = 'src/profit_feature_foundry.mjs';
    const file = path.join(worktree, rel);
    let source = fs.readFileSync(file, 'utf8');
    if ((source.match(new RegExp(good.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1) throw new Error('controlled mutation anchor count != 1');
    source = source.replace(good, bad);
    fs.writeFileSync(file, source, 'utf8');
    const baseline = spawnSync(process.execPath, ['--test', 'tests/profit_feature_foundry_live_logic.test.mjs'], { cwd: worktree, encoding: 'utf8', windowsHide: true });
    if (baseline.status === 0) throw new Error('controlled mutation did not fail target regression test');
    const test = fs.readFileSync(path.join(worktree, 'tests/profit_feature_foundry_live_logic.test.mjs'), 'utf8');
    const prompt = `REAL PROJECT TASK CODER-REPAIR-001\nA detached worktree of the real repository contains one controlled regression. Diagnose it from the mutated source excerpt and the existing regression test. Return an exact single-file oldText/newText replacement; do not rewrite unrelated code.\n\n--- mutated src/profit_feature_foundry.mjs excerpt ---\n${excerpt(source, bad, 1500)}\n\n--- actual regression test ---\n${test}`;
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['targetFile','oldText','newText','reason'],
      properties: { targetFile: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, reason: { type: 'string' } }
    };
    const answer = await ask(model, prompt, schema, options);
    const contract = contractScore(schema, answer.parsed);
    const out = answer.parsed.value;
    let patchApplied = false, testPassed = false, testStatus = null;
    if (out?.targetFile === rel && typeof out.oldText === 'string' && typeof out.newText === 'string') {
      let current = fs.readFileSync(file, 'utf8');
      const count = current.split(out.oldText).length - 1;
      if (count === 1) {
        current = current.replace(out.oldText, out.newText);
        fs.writeFileSync(file, current, 'utf8');
        patchApplied = true;
        const repaired = spawnSync(process.execPath, ['--test', 'tests/profit_feature_foundry_live_logic.test.mjs'], { cwd: worktree, encoding: 'utf8', windowsHide: true });
        testStatus = repaired.status;
        testPassed = repaired.status === 0;
      }
    }
    const semantic = (patchApplied ? 50 : 0) + (testPassed ? 50 : 0);
    return { id, weight: 2, semantic, contract, quality: semantic * 0.8 + contract * 0.2, output: out, patchApplied, testPassed, testStatus, baselineFailedAsExpected: true, metrics: answer };
  } finally {
    try { git(target, 'worktree', 'remove', '--force', worktree); } catch { try { fs.rmSync(worktree, { recursive: true, force: true }); } catch {} }
  }
}

async function run() {
  const target = path.resolve(String(arg('target', defaultTarget)));
  const models = String(arg('models', 'qwen3.6:35b-a3b,gemma4:12b')).split(',').map(x => x.trim()).filter(Boolean);
  const options = {
    context: Math.max(2048, Number(arg('context', '4096'))),
    maxOutputTokens: Math.max(96, Number(arg('max-output', '256'))),
    timeoutSeconds: Math.max(30, Number(arg('timeout-seconds', '90'))),
  };
  if (!fs.existsSync(path.join(target, '.git'))) throw new Error(`target git repository not found: ${target}`);
  const targetHead = git(target, 'rev-parse', 'HEAD');
  const targetDirty = Boolean(git(target, 'status', '--porcelain'));
  const runStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `REAL-${runStamp}`;
  const runDir = path.join(root, 'experiment-cache', 'real-project-benchmark', runId);
  const resultDir = path.join(root, 'benchmarks', 'real-project', 'results');
  fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(resultDir, { recursive: true });
  console.log(`[real-project] target=${target}`);
  console.log(`[real-project] target_head=${targetHead} dirty=${targetDirty}`);
  console.log(`[real-project] models=${models.join(',')} context=${options.context}`);

  const taskA = explorerTask(target), taskB = causalityTask(target);
  const modelResults = [];
  for (const model of models) {
    unload(model);
    console.log(`[real-project] MODEL_START ${model}`);
    const tasks = [];
    for (const task of [taskA, taskB]) {
      const answer = await ask(model, task.prompt, task.schema, options);
      const semantic = task.score(answer.parsed.value);
      const contract = contractScore(task.schema, answer.parsed);
      const quality = semantic * 0.8 + contract * 0.2;
      tasks.push({ id: task.id, weight: task.weight, semantic, contract, quality, output: answer.parsed.value, strict: answer.parsed.strict, metrics: answer });
      console.log(`[real-project] CASE ${model} ${task.id} semantic=${round2(semantic)} contract=${round2(contract)} quality=${round2(quality)} wall_s=${round2(answer.wallSeconds)}`);
    }
    const coder = await codingTask(model, target, targetHead, runDir, options);
    tasks.push(coder);
    console.log(`[real-project] CASE ${model} ${coder.id} semantic=${round2(coder.semantic)} contract=${round2(coder.contract)} quality=${round2(coder.quality)} patch=${coder.patchApplied} test=${coder.testPassed}`);
    const totalWeight = tasks.reduce((s, x) => s + x.weight, 0);
    const weighted = key => tasks.reduce((s, x) => s + x[key] * x.weight, 0) / totalWeight;
    const residency = await modelResidency(model);
    const totalWall = tasks.reduce((s, x) => s + Number(x.metrics?.wallSeconds || 0), 0);
    const result = { model, semantic: weighted('semantic'), contract: weighted('contract'), quality: weighted('quality'), totalWallSeconds: totalWall, residency, tasks };
    modelResults.push(result);
    console.log(`[real-project] MODEL_RESULT ${model} semantic=${round2(result.semantic)} contract=${round2(result.contract)} quality=${round2(result.quality)} wall_s=${round2(totalWall)}`);
    unload(model);
  }
  modelResults.sort((a,b) => b.quality - a.quality || a.totalWallSeconds - b.totalWallSeconds);
  const payload = {
    schema: 'RealProjectModelBenchmark@1.0.0', runId, createdAt: new Date().toISOString(),
    target: { path: target, head: targetHead, workingTreeDirty: targetDirty },
    hardware: { hostname: os.hostname(), platform: process.platform, arch: process.arch },
    options, modelResults,
    ranking: modelResults.map((x,i) => ({ rank: i + 1, model: x.model, quality: round2(x.quality), semantic: round2(x.semantic), contract: round2(x.contract), wallSeconds: round2(x.totalWallSeconds) })),
    profitabilityClaim: false,
  };
  const resultPath = path.join(resultDir, `${runStamp}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[real-project] RESULT_PATH=${resultPath}`);
  console.log('[real-project] RANKING');
  for (const row of payload.ranking) console.log(`  ${row.rank}. ${row.model} quality=${row.quality} semantic=${row.semantic} contract=${row.contract} wall_s=${row.wallSeconds}`);
}

function selfTest() {
  const strict = parseOneJson('{"x":1}');
  const recovered = parseOneJson('{"x":1}\nextra');
  if (!strict.strict || strict.value?.x !== 1 || !recovered.recovered || recovered.strict) throw new Error('JSON parser self-test failed');
  const schema = { type:'object', additionalProperties:false, required:['x'], properties:{x:{type:'integer'}} };
  if (contractScore(schema, strict) !== 100) throw new Error('contract scorer self-test failed');
  console.log('[real-project] SELF_TEST_PASS schema=RealProjectModelBenchmark@1.0.0 tasks=3');
}

try {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'run') await run();
  else throw new Error('usage: node scripts/real_project_benchmark.mjs <self-test|run> [--target path] [--models a,b]');
} catch (error) {
  console.error(`[real-project] ERROR ${String(error?.stack || error?.message || error)}`);
  process.exit(1);
}
