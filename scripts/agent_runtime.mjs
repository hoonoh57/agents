import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const localEnv = { ...readEnvFile(path.join(root, '.env')), ...process.env };
const registry = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'agents.json'), 'utf8'));
const registryMap = new Map(registry.agents.map(a => [a.agentId, a]));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function nowIso() { return new Date().toISOString(); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fail(message, code = 1) { console.error(`[agent-runtime] ERROR ${message}`); process.exit(code); }
function requireAgent(agentId) {
  const a = registryMap.get(agentId);
  if (!a || !a.enabled) fail(`unknown/disabled agent: ${agentId}`);
  return a;
}
function statePath(agentId) { return path.join(root, 'agents', agentId, 'STATE.json'); }
function updateState(agentId, patch) {
  const file = statePath(agentId);
  const state = readJson(file);
  writeJson(file, { ...state, ...patch, updatedAt: nowIso() });
}
function backlogPath() { return path.join(root, 'coordinator', 'BACKLOG.json'); }
function updateBacklog(taskId, patch) {
  const file = backlogPath();
  const backlog = readJson(file);
  const index = backlog.items.findIndex(x => x.taskId === taskId);
  if (index >= 0) backlog.items[index] = { ...backlog.items[index], ...patch };
  writeJson(file, backlog);
}
function taskId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `TASK-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}
function resultId(taskIdValue) { return `RESULT-${taskIdValue.slice(5)}`; }

function leaseDb() {
  const dbFile = localEnv.AGENT_LEASE_DB || path.join(root, 'runtime', 'agent_leases.sqlite3');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS leases (
    task_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    leased_until INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  )`);
  return db;
}
function claimLease(db, taskIdValue) {
  const now = Date.now();
  db.prepare('DELETE FROM leases WHERE leased_until < ?').run(now);
  const seconds = Math.max(30, Number(localEnv.AGENT_LEASE_SECONDS || 900));
  try {
    db.prepare('INSERT INTO leases(task_id, worker_id, leased_until, heartbeat_at) VALUES(?,?,?,?)')
      .run(taskIdValue, localEnv.AGENT_WORKER_ID || 'local-01', now + seconds * 1000, now);
    return true;
  } catch { return false; }
}
function releaseLease(db, taskIdValue) {
  db.prepare('DELETE FROM leases WHERE task_id = ?').run(taskIdValue);
}

function listQueuedTasks() {
  const tasks = [];
  for (const a of registry.agents.filter(x => x.enabled)) {
    const dir = path.join(root, 'agents', a.agentId, 'inbox');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const file = path.join(dir, name);
      try {
        const task = readJson(file);
        if (task.schema !== 'AgentTask@1.0.0' || task.agentId !== a.agentId || task.status !== 'QUEUED') continue;
        tasks.push({ file, task });
      } catch { /* malformed files are ignored by worker; validator surfaces structure errors separately */ }
    }
  }
  tasks.sort((x, y) => (Number(y.task.priority || 0) - Number(x.task.priority || 0)) || String(x.task.createdAt).localeCompare(String(y.task.createdAt)));
  return tasks;
}

function buildPrompt(task, agent) {
  const base = path.join(root, 'agents', agent.agentId);
  const read = name => fs.existsSync(path.join(base, name)) ? fs.readFileSync(path.join(base, name), 'utf8') : '';
  const sharedRules = fs.existsSync(path.join(root, 'shared', 'RESEARCH_RULES.md')) ? fs.readFileSync(path.join(root, 'shared', 'RESEARCH_RULES.md'), 'utf8') : '';
  return [
    '# AGENT', read('AGENT.md'),
    '# SHARED RULES', sharedRules,
    '# GOALS', read('GOALS.md'),
    '# PLAN', read('PLAN.md'),
    '# MEMORY INDEX', read('MEMORY_INDEX.md'),
    '# TASK', JSON.stringify(task, null, 2),
    '# RESPONSE REQUIREMENT',
    'Return concise research work product. Do not claim profitability without validated evidence. Do not execute broker/order actions.'
  ].join('\n\n');
}

function modelForRole(role) {
  if (role === 'LOCAL_CODER') return localEnv.LOCAL_LLM_CODER_MODEL || '';
  if (role === 'LOCAL_FAST') return localEnv.LOCAL_LLM_FAST_MODEL || '';
  return localEnv.LOCAL_LLM_REASONER_MODEL || '';
}

async function runOllama(task, agent) {
  const role = task.modelRoleHint || agent.modelRoleHint || 'LOCAL_REASONER';
  const model = modelForRole(role);
  if (!model) throw new Error(`MODEL_NOT_CONFIGURED:${role}`);
  const base = (localEnv.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: buildPrompt(task, agent), stream: false })
  });
  if (!response.ok) throw new Error(`OLLAMA_HTTP_${response.status}`);
  const body = await response.json();
  if (typeof body.response !== 'string') throw new Error('OLLAMA_RESPONSE_MISSING');
  return { text: body.response.trim(), model, role };
}

async function enqueue() {
  const agentId = arg('agent');
  const goalId = arg('goal');
  const objective = arg('objective');
  if (!agentId || !goalId || !objective) fail('enqueue requires --agent --goal --objective');
  const agent = requireAgent(agentId);
  const id = taskId();
  const task = {
    schema: 'AgentTask@1.0.0', taskId: id, agentId, goalId,
    priority: Number(arg('priority', '50')), status: 'QUEUED', createdBy: arg('created-by', 'COORDINATOR'),
    createdAt: nowIso(), objective, inputs: [], requiredOutputs: [], constraints: [], artifactRefs: [], dependsOn: [],
    modelRoleHint: arg('model-role', agent.modelRoleHint || 'LOCAL_REASONER'),
    externalEscalationAllowed: String(localEnv.AGENT_ALLOW_EXTERNAL_ESCALATION || 'true').toLowerCase() === 'true', attempt: 1
  };
  writeJson(path.join(root, 'agents', agentId, 'inbox', `${id}.json`), task);
  updateState(agentId, { status: 'QUEUED', activeTaskId: null, blockedReason: null });
  const backlog = readJson(backlogPath());
  backlog.items.push({ taskId: id, agentId, goalId, priority: task.priority, status: 'QUEUED', createdAt: task.createdAt });
  writeJson(backlogPath(), backlog);
  console.log(`[agent-runtime] ENQUEUED ${id} -> ${agentId}`);
}

async function workerOnce() {
  const mock = flag('mock');
  const db = leaseDb();
  try {
    for (const item of listQueuedTasks()) {
      const task = item.task;
      const agent = requireAgent(task.agentId);
      if (!claimLease(db, task.taskId)) continue;
      const startedAt = nowIso();
      const workFile = path.join(root, 'agents', task.agentId, 'work', `${task.taskId}.json`);
      writeJson(workFile, { ...task, status: 'RUNNING', startedAt, workerId: localEnv.AGENT_WORKER_ID || 'local-01' });
      updateState(task.agentId, { status: 'RUNNING', activeTaskId: task.taskId, blockedReason: null });
      updateBacklog(task.taskId, { status: 'RUNNING', startedAt });
      try {
        const exec = mock
          ? { text: `MOCK PASS: ${task.objective}`, model: 'mock-deterministic', role: task.modelRoleHint || agent.modelRoleHint }
          : await runOllama(task, agent);
        const rid = resultId(task.taskId);
        const completedAt = nowIso();
        const result = {
          schema: 'AgentResult@1.0.0', resultId: rid, taskId: task.taskId, agentId: task.agentId,
          status: 'COMPLETED', modelProfile: exec.role, modelVersion: exec.model,
          startedAt, completedAt, summary: exec.text, claims: [], sourceRefs: [], proposalRefs: [], artifactRefs: [],
          requiresValidation: true, externalEscalation: null
        };
        writeJson(path.join(root, 'agents', task.agentId, 'results', `${rid}.json`), result);
        writeJson(workFile, { ...task, status: 'COMPLETED', startedAt, completedAt, resultId: rid, workerId: localEnv.AGENT_WORKER_ID || 'local-01' });
        fs.unlinkSync(item.file);
        updateState(task.agentId, { status: 'COMPLETED', activeTaskId: null, lastCompletedTaskId: task.taskId, blockedReason: null });
        updateBacklog(task.taskId, { status: 'COMPLETED', completedAt, resultId: rid });
        console.log(`[agent-runtime] COMPLETED ${task.taskId} -> ${rid}${mock ? ' [MOCK]' : ''}`);
        return;
      } catch (error) {
        const message = String(error?.message || error);
        const failedStatus = message.startsWith('MODEL_NOT_CONFIGURED') ? 'BLOCKED' : 'ERROR';
        writeJson(item.file, { ...task, status: failedStatus, failedAt: nowIso(), error: message });
        writeJson(workFile, { ...task, status: failedStatus, startedAt, failedAt: nowIso(), error: message, workerId: localEnv.AGENT_WORKER_ID || 'local-01' });
        updateState(task.agentId, { status: failedStatus, activeTaskId: null, blockedReason: message });
        updateBacklog(task.taskId, { status: failedStatus, error: message });
        console.error(`[agent-runtime] TASK FAILED ${task.taskId}: ${message}`);
        return;
      } finally {
        releaseLease(db, task.taskId);
      }
    }
    console.log('[agent-runtime] IDLE no runnable queued task');
  } finally { db.close(); }
}

function validate() {
  let errors = 0;
  for (const a of registry.agents) {
    const base = path.join(root, 'agents', a.agentId);
    for (const required of ['AGENT.md','STATE.json','GOALS.md','PLAN.md','MEMORY_INDEX.md','HANDOFF.md','inbox','work','results','notes']) {
      if (!fs.existsSync(path.join(base, required))) { console.error(`[agent-runtime] MISSING ${a.agentId}/${required}`); errors++; }
    }
    if (fs.existsSync(statePath(a.agentId))) {
      const s = readJson(statePath(a.agentId));
      if (s.schema !== 'AgentState@1.0.0' || s.agentId !== a.agentId) { console.error(`[agent-runtime] INVALID STATE ${a.agentId}`); errors++; }
    }
  }
  const backlog = readJson(backlogPath());
  if (backlog.schema !== 'CoordinatorBacklog@1.0.0' || !Array.isArray(backlog.items)) { console.error('[agent-runtime] INVALID coordinator/BACKLOG.json'); errors++; }
  if (errors) fail(`validation failed errors=${errors}`);
  console.log(`[agent-runtime] PASS registry=${registry.agents.length} workspaces=${registry.agents.length} backlogItems=${backlog.items.length}`);
}

const command = process.argv[2];
if (command === 'enqueue') await enqueue();
else if (command === 'worker-once') await workerOnce();
else if (command === 'validate') validate();
else fail('usage: node scripts/agent_runtime.mjs <validate|enqueue|worker-once> [...]');
