import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTaskInputs, PROJECT_CONTEXT_INPUT_SCHEMA } from './project_context_adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function selfTest() {
  const env = { ...process.env, RESEARCH_LOCAL_ROOT: root, AGENT_CONTEXT_MAX_BYTES: '16000' };
  const task = {
    inputs: [
      { schema: PROJECT_CONTEXT_INPUT_SCHEMA, inputId: 'readme', root: 'RESEARCH_LOCAL_ROOT', path: 'README.md', mode: 'FULL', maxBytes: 4096 },
      { schema: PROJECT_CONTEXT_INPUT_SCHEMA, inputId: 'task-schema', root: 'RESEARCH_LOCAL_ROOT', path: 'AGENT_WORKSPACE_SCHEMA.md', mode: 'AROUND', anchor: '## AgentTask@1.0.0', beforeChars: 80, afterChars: 900, maxBytes: 1600 },
      { schema: PROJECT_CONTEXT_INPUT_SCHEMA, inputId: 'agent-decision', root: 'AGENT_REPO_ROOT', path: 'coordinator/decisions/P3_FEATURE_ARCHITECT_NEXT_TRIGGER_002_REJECTED.json', mode: 'FULL', maxBytes: 7000 }
    ]
  };
  const resolved = resolveTaskInputs(task, env);
  if (resolved.sourceRefs.length !== 3 || resolved.totalBytes <= 0) throw new Error('resolution self-test failed');
  if (!resolved.promptSection.includes('AgentTask@1.0.0')) throw new Error('anchor self-test failed');
  const decision = resolved.sourceRefs.find(x => x.inputId === 'agent-decision');
  if (!decision || decision.root !== 'AGENT_REPO_ROOT' || decision.relativePath !== 'coordinator/decisions/P3_FEATURE_ARCHITECT_NEXT_TRIGGER_002_REJECTED.json') {
    throw new Error('agent repository root self-test failed');
  }
  let rejected = false;
  try {
    resolveTaskInputs({ inputs: [{ schema: PROJECT_CONTEXT_INPUT_SCHEMA, inputId: 'escape', root: 'AGENT_REPO_ROOT', path: '../README.md', mode: 'FULL' }] }, env);
  } catch (error) {
    rejected = String(error?.message || error).startsWith('CONTEXT_PATH_FORBIDDEN');
  }
  if (!rejected) throw new Error('path traversal self-test failed');
  console.log(`[project-context-verify] SELF_TEST_PASS sources=${resolved.sourceRefs.length} bytes=${resolved.totalBytes}`);
}

function validateTemplate() {
  const templateName = String(arg('template', '')).trim().replace(/\\/g, '/');
  if (!templateName || templateName.includes('..') || path.isAbsolute(templateName)) throw new Error('invalid --template');
  const templatePath = path.resolve(root, 'task-templates', templateName);
  const template = readJson(templatePath);
  if (template.schema !== 'AgentTaskTemplate@1.0.0') throw new Error(`invalid template schema ${String(template.schema || 'missing')}`);
  const resolved = resolveTaskInputs(template, process.env);
  console.log(`[project-context-verify] TEMPLATE_PASS template=${templateName} sources=${resolved.sourceRefs.length} bytes=${resolved.totalBytes}`);
  for (const ref of resolved.sourceRefs) {
    console.log(`[project-context-verify] SOURCE ${ref.inputId} root=${ref.root} path=${ref.relativePath} head=${ref.repositoryHead || 'n/a'} excerpt_bytes=${ref.excerptBytes} sha256=${ref.excerptSha256.slice(0, 12)}`);
  }
}

try {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else if (command === 'template') validateTemplate();
  else throw new Error('usage: node scripts/verify_project_context.mjs <self-test|template> [--template file.json]');
} catch (error) {
  console.error(`[project-context-verify] ERROR ${String(error?.stack || error?.message || error)}`);
  process.exit(1);
}
