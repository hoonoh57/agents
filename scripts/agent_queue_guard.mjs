import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TARGET_PRIORITY = Number.MAX_SAFE_INTEGER;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function backlogPath() { return path.join(root, 'coordinator', 'BACKLOG.json'); }
function registry() { return readJson(path.join(root, 'registry', 'agents.json')); }
function validTaskId(value) { return /^TASK-[A-Za-z0-9-]+$/.test(String(value || '')); }

function inboxEntries() {
  const entries = [];
  for (const agent of registry().agents.filter(x => x.enabled)) {
    const dir = path.join(root, 'agents', agent.agentId, 'inbox');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const file = path.join(dir, name);
      try {
        const task = readJson(file);
        if (task.schema === 'AgentTask@1.0.0' && task.taskId && task.agentId === agent.agentId) entries.push({ file, task });
      } catch {}
    }
  }
  return entries;
}

function reconcile() {
  const backlog = readJson(backlogPath());
  const byId = new Map(backlog.items.map(x => [x.taskId, x]));
  let updated = 0;
  let removed = 0;
  let orphaned = 0;
  for (const entry of inboxEntries()) {
    const row = byId.get(entry.task.taskId);
    if (!row) { orphaned += 1; continue; }
    const status = String(row.status || '');
    if (status === 'COMPLETED') {
      fs.unlinkSync(entry.file);
      removed += 1;
      continue;
    }
    if (['QUEUED', 'RUNNING', 'ERROR', 'BLOCKED'].includes(status) && entry.task.status !== status) {
      writeJson(entry.file, { ...entry.task, status });
      updated += 1;
    }
  }
  console.log(`[queue-guard] RECONCILE updated=${updated} removed=${removed} orphaned=${orphaned}`);
  return { updated, removed, orphaned };
}

function findTarget(taskId) {
  return inboxEntries().find(x => x.task.taskId === taskId) || null;
}

function activeLease(taskId) {
  const file = path.join(root, 'runtime', 'leases', `${taskId}.lock`);
  if (!fs.existsSync(file)) return false;
  try {
    const lease = readJson(file);
    if (Number(lease.leasedUntil || 0) > Date.now()) return true;
    fs.unlinkSync(file);
    return false;
  } catch {
    try { fs.unlinkSync(file); } catch {}
    return false;
  }
}

function targetOnce() {
  const taskId = String(arg('task', '')).trim();
  if (!validTaskId(taskId)) throw new Error(`TARGET_TASK_ID_INVALID:${taskId || 'missing'}`);
  reconcile();
  if (activeLease(taskId)) throw new Error(`TARGET_TASK_LEASE_BUSY:${taskId}`);

  const backlogFile = backlogPath();
  const backlog = readJson(backlogFile);
  const index = backlog.items.findIndex(x => x.taskId === taskId);
  if (index < 0) throw new Error(`TARGET_TASK_BACKLOG_MISSING:${taskId}`);
  const row = backlog.items[index];
  if (!['QUEUED', 'ERROR', 'BLOCKED'].includes(String(row.status || ''))) {
    throw new Error(`TARGET_TASK_STATUS_INVALID:${taskId}:${String(row.status || 'missing')}`);
  }

  const entry = findTarget(taskId);
  if (!entry) throw new Error(`TARGET_TASK_INBOX_MISSING:${taskId}`);
  const originalPriority = Number(entry.task.priority || 0);
  writeJson(entry.file, { ...entry.task, status: 'QUEUED', priority: MAX_TARGET_PRIORITY });
  backlog.items[index] = { ...row, status: 'QUEUED', error: null };
  writeJson(backlogFile, backlog);
  console.log(`[queue-guard] TARGET task=${taskId} originalPriority=${originalPriority}`);

  const router = path.join(root, 'scripts', 'agent_worker_router.mjs');
  const args = [router, 'worker-once'];
  if (flag('mock')) args.push('--mock');
  let child;
  try {
    child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`TARGET_ROUTER_EXIT:${child.status ?? 1}`);
  } finally {
    const afterBacklog = readJson(backlogFile);
    const after = afterBacklog.items.find(x => x.taskId === taskId);
    const remaining = findTarget(taskId);
    if (remaining && after) {
      writeJson(remaining.file, { ...remaining.task, priority: originalPriority, status: String(after.status || remaining.task.status) });
    }
  }

  const finalBacklog = readJson(backlogFile);
  const finalRow = finalBacklog.items.find(x => x.taskId === taskId);
  const finalStatus = String(finalRow?.status || 'missing');
  if (!['COMPLETED', 'ERROR', 'BLOCKED'].includes(finalStatus)) {
    throw new Error(`TARGET_TASK_NOT_PROCESSED:${taskId}:${finalStatus}`);
  }
  console.log(`[queue-guard] TARGET_DONE task=${taskId} status=${finalStatus}`);
}

function selfTest() {
  if (!validTaskId('TASK-20260814000000-abc123')) throw new Error('self-test task id failed');
  if (validTaskId('BAD')) throw new Error('self-test invalid task id failed');
  if (MAX_TARGET_PRIORITY <= 1000000) throw new Error('self-test priority failed');
  console.log('AGENT_QUEUE_GUARD_SELF_TEST_PASS');
}

const command = process.argv[2];
if (command === 'reconcile') reconcile();
else if (command === 'target-once') targetOnce();
else if (command === 'self-test') selfTest();
else throw new Error('usage: node scripts/agent_queue_guard.mjs <reconcile|target-once|self-test> [--task TASK-...] [--mock]');
