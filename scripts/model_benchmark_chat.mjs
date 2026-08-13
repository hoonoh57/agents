import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_candidates.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'model_benchmark_cases_v3.json'), 'utf8'));
const baseUrl = 'http://127.0.0.1:11434';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function parseOneJson(raw) {
  const text = String(raw ?? '').trim();
  try {
    return { value: JSON.parse(text), strict: true, recovered: false, trailing: 0 };
  } catch {
    const start = text.indexOf('{');
    if (start < 0) return { value: null, strict: false, recovered: false, trailing: text.length };
    let depth = 0;
    let quoted = false;
    let escaped = false;
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
        } catch {
          return { value: null, strict: false, recovered: false, trailing: text.length };
        }
      }
    }
    return { value: null, strict: false, recovered: false, trailing: text.length };
  }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function contains(a, b) { return String(a ?? '').toLowerCase().includes(String(b).toLowerCase()); }
function round2(n) { return Math.round(n * 100) / 100; }

function semanticScore(testCase, output) {
  const checks = [];
  for (const [key, expected] of Object.entries(testCase.expected || {})) {
    checks.push(same(output?.[key], expected));
  }
  for (const [key, values] of Object.entries(testCase.requiredContains || {})) {
    for (const value of values) checks.push(contains(output?.[key], value));
  }
  for (const [key, values] of Object.entries(testCase.forbiddenContains || {})) {
    for (const value of values) checks.push(!contains(output?.[key], value));
  }
  return checks.length ? checks.filter(Boolean).length / checks.length * 100 : 0;
}

function contractScore(testCase, parsed) {
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return 0;
  const schema = testCase.responseSchema;
  const checks = [parsed.strict];
  for (const key of schema.required || []) checks.push(Object.hasOwn(parsed.value, key));
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    checks.push(Object.keys(parsed.value).every(key => allowed.has(key)));
  }
  return checks.filter(Boolean).length / checks.length * 100;
}

async function ask(model, testCase, context) {
  const schemaText = JSON.stringify(testCase.responseSchema);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return exactly one JSON object matching the supplied schema. No markdown or extra text.' },
        { role: 'user', content: `${testCase.prompt}\n\nJSON SCHEMA:\n${schemaText}` }
      ],
      format: testCase.responseSchema,
      stream: false,
      options: { temperature: 0, num_ctx: context }
    })
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = await response.json();
  const evalSeconds = Number(body.eval_duration || 0) / 1e9;
  return {
    parsed: parseOneJson(body?.message?.content ?? ''),
    tokensPerSecond: evalSeconds > 0 ? Number(body.eval_count || 0) / evalSeconds : null
  };
}

function selfTest() {
  const strict = parseOneJson('{"x":1}');
  const recovered = parseOneJson('{"x":1}\nextra');
  if (!strict.strict || strict.value?.x !== 1) throw new Error('strict parse self-test failed');
  if (!recovered.recovered || recovered.strict || recovered.value?.x !== 1) throw new Error('recovery self-test failed');
  console.log(`[model-benchmark-chat] SELF_TEST_PASS candidates=${candidates.candidates.length} cases=${cases.cases.length}`);
}

async function run() {
  const names = String(arg('models', 'gemma4:12b')).split(',').map(x => x.trim()).filter(Boolean);
  const context = Math.max(1024, Number(arg('context', '4096')));
  for (const model of names) {
    const candidate = candidates.candidates.find(x => x.model === model);
    if (!candidate) throw new Error(`unregistered model: ${model}`);
    console.log(`[model-benchmark-chat] MODEL_START ${model}`);
    const rows = [];
    for (const testCase of cases.cases.filter(x => candidate.roles.includes(x.role))) {
      const answer = await ask(model, testCase, context);
      const semantic = semanticScore(testCase, answer.parsed.value);
      const contract = contractScore(testCase, answer.parsed);
      const quality = semantic * 0.8 + contract * 0.2;
      rows.push({ weight: testCase.weight, semantic, contract, quality, speed: answer.tokensPerSecond });
      console.log(`[model-benchmark-chat] CASE_RESULT ${model} ${testCase.caseId} semantic=${round2(semantic)} contract=${round2(contract)} quality=${round2(quality)} strict=${answer.parsed.strict} recovered=${answer.parsed.recovered} trailing=${answer.parsed.trailing} tok_s=${answer.tokensPerSecond?.toFixed?.(2) ?? 'n/a'}`);
      if (!answer.parsed.strict) console.log(`[model-benchmark-chat] PARSED ${JSON.stringify(answer.parsed.value)}`);
    }
    const weight = rows.reduce((s, x) => s + x.weight, 0) || 1;
    const weighted = key => rows.reduce((s, x) => s + x[key] * x.weight, 0) / weight;
    const speeds = rows.map(x => x.speed).filter(Number.isFinite);
    const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
    console.log(`[model-benchmark-chat] MODEL_RESULT ${model} semantic=${round2(weighted('semantic'))} contract=${round2(weighted('contract'))} quality=${round2(weighted('quality'))} tok_s=${avgSpeed ? round2(avgSpeed) : 'n/a'}`);
  }
}

try {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'run') await run();
  else throw new Error('usage: node scripts/model_benchmark_chat.mjs <self-test|run> [--models a,b] [--context 4096]');
} catch (error) {
  console.error(`[model-benchmark-chat] ERROR ${String(error?.message || error)}`);
  process.exit(1);
}
