import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAutonomousResearchTask, selfTestAutonomousResearchEngine } from './autonomous_research_engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'registry', 'agents.json'), 'utf8'));
const registryMap = new Map(registry.agents.map(x => [x.agentId, x]));

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
const env = { ...readEnvFile(path.join(root, '.env')), ...process.env };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function nowIso() { return new Date().toISOString(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function requireAgent(agentId) {
  const agent = registryMap.get(agentId);
  if (!agent || !agent.enabled) throw new Error(`unknown/disabled agent: ${agentId}`);
  return agent;
}
function executionMode(task) { return String(task.executionMode || 'ANALYSIS').toUpperCase(); }
function statePath(agentId) { return path.join(root, 'agents', agentId, 'STATE.json'); }
function backlogPath() { return path.join(root, 'coordinator', 'BACKLOG.json'); }
function updateState(agentId, patch) { const current = readJson(statePath(agentId)); writeJson(statePath(agentId), { ...current, ...patch, updatedAt: nowIso() }); }
function updateBacklog(taskId, patch) {
  const file = backlogPath();
  const backlog = readJson(file);
  const index = backlog.items.findIndex(x => x.taskId === taskId);
  if (index >= 0) backlog.items[index] = { ...backlog.items[index], ...patch };
  writeJson(file, backlog);
}
function listQueuedTasks() {
  const items = [];
  for (const agent of registry.agents.filter(x => x.enabled)) {
    const dir = path.join(root, 'agents', agent.agentId, 'inbox');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const file = path.join(dir, name);
      try {
        const task = readJson(file);
        if (task.schema === 'AgentTask@1.0.0' && task.agentId === agent.agentId && task.status === 'QUEUED') items.push({ file, task });
      } catch {}
    }
  }
  items.sort((a, b) => (Number(b.task.priority || 0) - Number(a.task.priority || 0)) || String(a.task.createdAt).localeCompare(String(b.task.createdAt)));
  return items;
}

function leaseDir() { const dir = path.join(root, 'runtime', 'leases'); fs.mkdirSync(dir, { recursive: true }); return dir; }
function leasePath(taskId) { return path.join(leaseDir(), `${taskId}.lock`); }
function claimLease(taskId) {
  const file = leasePath(taskId);
  const now = Date.now();
  const leaseMs = Math.max(30, Number(env.AGENT_LEASE_SECONDS || 900)) * 1000;
  if (fs.existsSync(file)) {
    try { if (Number(readJson(file).leasedUntil || 0) < now) fs.unlinkSync(file); } catch { try { fs.unlinkSync(file); } catch {} }
  }
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ taskId, workerId: env.AGENT_WORKER_ID || 'local-01', leasedAt: now, leasedUntil: now + leaseMs }) + '\n', 'utf8');
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function releaseLease(taskId) { try { fs.unlinkSync(leasePath(taskId)); } catch {} }
function taskId() { return `TASK-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`; }
function resultId(taskIdValue) { return `RESULT-${taskIdValue.slice(5)}`; }

function loadTemplate(name) {
  const safe = String(name || '').trim().replace(/\\/g, '/');
  if (!safe || safe.includes('..') || path.isAbsolute(safe)) throw new Error(`TASK_TEMPLATE_INVALID:${safe || 'missing'}`);
  const file = path.join(root, 'task-templates', safe);
  const template = readJson(file);
  if (template.schema !== 'AgentTaskTemplate@1.0.0') throw new Error('TASK_TEMPLATE_SCHEMA_INVALID');
  if (String(template.executionMode || '').toUpperCase() !== 'AUTONOMOUS_RESEARCH') throw new Error('TASK_TEMPLATE_NOT_AUTONOMOUS_RESEARCH');
  return { ...template, templateFile: `task-templates/${safe}` };
}

function enqueueAutonomous() {
  const template = loadTemplate(arg('template'));
  const agent = requireAgent(template.agentId);
  const goalFile = path.join(root, 'goals', `${template.goalId}.json`);
  if (!fs.existsSync(goalFile)) throw new Error(`AUTONOMOUS_GOAL_MISSING:${template.goalId}`);
  const id = taskId();
  const task = {
    schema: 'AgentTask@1.0.0', taskId: id, agentId: template.agentId, goalId: template.goalId,
    executionMode: 'AUTONOMOUS_RESEARCH', priority: Number(template.priority ?? 50), status: 'QUEUED',
    createdBy: template.createdBy || 'COORDINATOR', createdAt: nowIso(), objective: template.objective,
    inputs: Array.isArray(template.inputs) ? template.inputs : [], requiredOutputs: Array.isArray(template.requiredOutputs) ? template.requiredOutputs : [],
    constraints: Array.isArray(template.constraints) ? template.constraints : [], artifactRefs: Array.isArray(template.artifactRefs) ? template.artifactRefs : [],
    dependsOn: Array.isArray(template.dependsOn) ? template.dependsOn : [], modelRoleHint: template.modelRoleHint || agent.modelRoleHint || 'LOCAL_REASONER',
    externalEscalationAllowed: String(env.AGENT_ALLOW_EXTERNAL_ESCALATION || 'true').toLowerCase() === 'true', attempt: 1, taskTemplate: template.templateFile,
  };
  writeJson(path.join(root, 'agents', task.agentId, 'inbox', `${id}.json`), task);
  updateState(task.agentId, { status: 'QUEUED', activeTaskId: null, blockedReason: null });
  const backlog = readJson(backlogPath());
  backlog.items.push({ taskId: id, agentId: task.agentId, goalId: task.goalId, executionMode: task.executionMode, priority: task.priority, status: 'QUEUED', createdAt: task.createdAt });
  writeJson(backlogPath(), backlog);
  console.log(`[agent-router] ENQUEUED ${id} -> ${task.agentId} mode=AUTONOMOUS_RESEARCH template=${template.templateFile}`);
}

function delegateStable(mock) {
  const script = path.join(root, 'scripts', 'agent_runtime_stable.mjs');
  const args = [script, 'worker-once'];
  if (mock) args.push('--mock');
  console.log('[agent-router] DELEGATE mode=ANALYSIS runtime=agent_runtime_stable.mjs');
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

async function runAutonomousOne(item, mock) {
  const task = item.task;
  const agent = requireAgent(task.agentId);
  if (!mock && env.AGENT_RESEARCH_WINDOW_ACTIVE !== '1') throw new Error('AUTONOMOUS_RESEARCH_WINDOW_REQUIRED');
  if (!claimLease(task.taskId)) { console.log(`[agent-router] LEASE_BUSY ${task.taskId}`); return; }
  const startedAt = nowIso();
  const workFile = path.join(root, 'agents', task.agentId, 'work', `${task.taskId}.json`);
  const runtimeRun = fs.existsSync(workFile) ? Number(readJson(workFile).runtimeRun || 0) + 1 : 1;
  writeJson(workFile, { ...task, status: 'RUNNING', startedAt, workerId: env.AGENT_WORKER_ID || 'local-01', runtimeRun });
  updateState(task.agentId, { status: 'RUNNING', activeTaskId: task.taskId, blockedReason: null });
  updateBacklog(task.taskId, { status: 'RUNNING', startedAt, error: null });
  try {
    const exec = mock ? {
      text: `MOCK PASS: ${task.objective}`, workProduct: null, sourceRefs: [], model: 'mock-deterministic', role: task.modelRoleHint || agent.modelRoleHint,
      autonomousResearch: { schema: 'AutonomousResearchTaskEvidence@1.0.0', goalId: task.goalId, mock: true, profitabilityClaim: false }, runtimeMetrics: { contextBytes: 0, keepAlive: 0 },
    } : await runAutonomousResearchTask({ root, task, agent, env });
    const rid = resultId(task.taskId);
    const completedAt = nowIso();
    const result = {
      schema: 'AgentResult@1.0.0', resultId: rid, taskId: task.taskId, agentId: task.agentId, executionMode: 'AUTONOMOUS_RESEARCH',
      status: 'COMPLETED', modelProfile: exec.role, modelVersion: exec.model, startedAt, completedAt, summary: exec.text,
      claims: [], sourceRefs: [], proposalRefs: [], artifactRefs: [], requiresValidation: true, externalEscalation: null,
      workProduct: null, autonomousResearch: exec.autonomousResearch, runtimeMetrics: exec.runtimeMetrics,
    };
    writeJson(path.join(root, 'agents', task.agentId, 'results', `${rid}.json`), result);
    writeJson(workFile, { ...task, status: 'COMPLETED', startedAt, completedAt, resultId: rid, workerId: env.AGENT_WORKER_ID || 'local-01', runtimeRun, autonomousResearch: exec.autonomousResearch, runtimeMetrics: exec.runtimeMetrics });
    fs.unlinkSync(item.file);
    updateState(task.agentId, { status: 'COMPLETED', activeTaskId: null, lastCompletedTaskId: task.taskId, blockedReason: null });
    updateBacklog(task.taskId, { status: 'COMPLETED', completedAt, resultId: rid, error: null });
    console.log(`[agent-router] COMPLETED ${task.taskId} -> ${rid} mode=AUTONOMOUS_RESEARCH${mock ? ' [MOCK]' : ''} attempts=${exec.runtimeMetrics?.outputAttempts || 1}`);
  } catch (error) {
    const message = String(error?.message || error);
    const blocked = message.startsWith('MODEL_NOT_CONFIGURED') || message.startsWith('AUTONOMOUS_GOAL_') || message.startsWith('AUTONOMOUS_CONFIG_') || message.startsWith('AUTONOMOUS_TOOL_UNAVAILABLE') || message.startsWith('AUTONOMOUS_TOOL_EXECUTOR_MISSING');
    const status = blocked ? 'BLOCKED' : 'ERROR';
    const failedAt = nowIso();
    writeJson(workFile, { ...task, status, startedAt, failedAt, workerId: env.AGENT_WORKER_ID || 'local-01', runtimeRun, error: message, errorDiagnostics: error?.diagnostics || null });
    updateState(task.agentId, { status, activeTaskId: null, blockedReason: message });
    updateBacklog(task.taskId, { status, error: message, failedAt });
    console.error(`[agent-router] TASK FAILED ${task.taskId}: ${message}`);
  } finally { releaseLease(task.taskId); }
}

async function workerOnce() {
  const mock = flag('mock');
  const items = listQueuedTasks();
  if (!items.length) { console.log('[agent-router] IDLE no runnable queued task'); return; }
  const first = items[0];
  const mode = executionMode(first.task);
  console.log(`[agent-router] SELECT task=${first.task.taskId} mode=${mode} priority=${Number(first.task.priority || 0)}`);
  if (mode !== 'AUTONOMOUS_RESEARCH') { delegateStable(mock); return; }
  await runAutonomousOne(first, mock);
}

function selfTest() {
  selfTestAutonomousResearchEngine({ root });
  const template = loadTemplate('autonomous-ma5-queue-smoke.json');
  if (template.agentId !== 'experiment-validation' || template.goalId !== 'GOAL-AUTONOMOUS-MA5-SMOKE-001') throw new Error('AUTONOMOUS_ROUTER_SELF_TEST_FAILED');
  console.log('AGENT_WORKER_ROUTER_SELF_TEST_PASS');
}

const command = process.argv[2];
if (command === 'worker-once') await workerOnce();
else if (command === 'enqueue') enqueueAutonomous();
else if (command === 'self-test') selfTest();
else throw new Error('usage: node scripts/agent_worker_router.mjs <self-test|enqueue|worker-once> [--template file] [--mock]');
