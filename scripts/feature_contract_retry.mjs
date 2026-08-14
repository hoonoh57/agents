import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFeatureDesignResult } from './verify_feature_design_contract.mjs';
import { validateVolumeContextDesignResult } from './verify_volume_context_design_contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT_TRIGGER_GOAL_PREFIX = 'GOAL-FEATURE-ARCHITECT-NEXT-TRIGGER-';
const VOLUME_CONTEXT_GOAL = 'GOAL-FEATURE-ARCHITECT-VOLUME-CONTEXT-001';
const MAX_REPAIRS = 2;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function backlogPath() { return path.join(root, 'coordinator', 'BACKLOG.json'); }
function statePath(agentId) { return path.join(root, 'agents', agentId, 'STATE.json'); }
function workPath(agentId, taskId) { return path.join(root, 'agents', agentId, 'work', `${taskId}.json`); }
function inboxPath(agentId, taskId) { return path.join(root, 'agents', agentId, 'inbox', `${taskId}.json`); }
function resultPath(agentId, taskId) { return path.join(root, 'agents', agentId, 'results', `RESULT-${taskId.slice(5)}.json`); }

function taskRow(taskId) {
  const backlog = readJson(backlogPath());
  const index = backlog.items.findIndex(x => x.taskId === taskId);
  if (index < 0) throw new Error(`FEATURE_CONTRACT_TASK_MISSING:${taskId}`);
  return { backlog, index, row: backlog.items[index] };
}

function validatorForGoal(goalId) {
  const goal = String(goalId || '');
  if (goal.startsWith(NEXT_TRIGGER_GOAL_PREFIX)) return validateFeatureDesignResult;
  if (goal === VOLUME_CONTEXT_GOAL) return validateVolumeContextDesignResult;
  return null;
}

function isFeatureContractTask(row) {
  return row?.agentId === 'feature-architect' && Boolean(validatorForGoal(row?.goalId));
}

function validateCurrent(row) {
  if (String(row.status || '') !== 'COMPLETED') throw new Error(`FEATURE_CONTRACT_EXPECTED_COMPLETED:${row.taskId}:${row.status}`);
  const file = resultPath(row.agentId, row.taskId);
  if (!fs.existsSync(file)) throw new Error(`FEATURE_CONTRACT_RESULT_MISSING:${row.taskId}`);
  const result = readJson(file);
  const validate = validatorForGoal(row.goalId);
  if (!validate) throw new Error(`FEATURE_CONTRACT_VALIDATOR_MISSING:${row.goalId}`);
  validate(result);
  return result;
}

function previousCompletedTaskId(backlog, row) {
  const prior = backlog.items.filter(x => x.agentId === row.agentId && x.taskId !== row.taskId && x.status === 'COMPLETED');
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const candidate = prior[i];
    const validate = validatorForGoal(candidate.goalId);
    if (!validate) return candidate.taskId;
    const file = resultPath(candidate.agentId, candidate.taskId);
    if (!fs.existsSync(file)) continue;
    try {
      validate(readJson(file));
      return candidate.taskId;
    } catch {}
  }
  return null;
}

function normalizeCompletedMetadata(taskId) {
  const { backlog, index, row } = taskRow(taskId);
  if (String(row.status || '') !== 'COMPLETED') return;
  const clean = { ...row, error: null };
  delete clean.failedAt;
  backlog.items[index] = clean;
  writeJson(backlogPath(), backlog);

  const stateFile = statePath(row.agentId);
  const state = readJson(stateFile);
  if (state.lastCompletedTaskId === taskId || state.status === 'COMPLETED') {
    writeJson(stateFile, {
      ...state,
      status: 'COMPLETED',
      activeTaskId: null,
      lastCompletedTaskId: taskId,
      blockedReason: null,
      updatedAt: new Date().toISOString(),
    });
  }
}

function rollbackForRepair(taskId, errorMessage, repairNumber) {
  const { backlog, index, row } = taskRow(taskId);
  const workFile = workPath(row.agentId, taskId);
  if (!fs.existsSync(workFile)) throw new Error(`FEATURE_CONTRACT_WORK_MISSING:${taskId}`);
  const work = readJson(workFile);
  const repairConstraint = `Previous generated output failed task-specific contract: ${errorMessage}. Correct this exact violation; do not repeat it.`;
  const constraints = (Array.isArray(work.constraints) ? work.constraints : [])
    .filter(x => !String(x).startsWith('Previous generated output failed task-specific contract:'));
  constraints.push(repairConstraint);

  const task = {
    schema: 'AgentTask@1.0.0',
    taskId: work.taskId,
    agentId: work.agentId,
    goalId: work.goalId,
    priority: Number(work.priority || row.priority || 0),
    status: 'ERROR',
    createdBy: work.createdBy,
    createdAt: work.createdAt,
    objective: work.objective,
    inputs: Array.isArray(work.inputs) ? work.inputs : [],
    requiredOutputs: Array.isArray(work.requiredOutputs) ? work.requiredOutputs : [],
    constraints,
    artifactRefs: Array.isArray(work.artifactRefs) ? work.artifactRefs : [],
    dependsOn: Array.isArray(work.dependsOn) ? work.dependsOn : [],
    modelRoleHint: work.modelRoleHint,
    externalEscalationAllowed: work.externalEscalationAllowed,
    attempt: Number(work.attempt || 1) + 1,
    taskTemplate: work.taskTemplate || null,
    previousContractError: errorMessage,
    contractRepair: repairNumber,
  };
  writeJson(inboxPath(row.agentId, taskId), task);

  const resultFile = resultPath(row.agentId, taskId);
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);

  const nextRow = { ...row, status: 'ERROR', error: errorMessage, failedAt: new Date().toISOString() };
  delete nextRow.completedAt;
  delete nextRow.resultId;
  backlog.items[index] = nextRow;
  writeJson(backlogPath(), backlog);

  const stateFile = statePath(row.agentId);
  const state = readJson(stateFile);
  writeJson(stateFile, {
    ...state,
    status: 'ERROR',
    activeTaskId: null,
    lastCompletedTaskId: previousCompletedTaskId(backlog, row),
    blockedReason: errorMessage,
    updatedAt: new Date().toISOString(),
  });
  console.log(`[feature-contract-retry] ROLLBACK task=${taskId} repair=${repairNumber} error=${errorMessage}`);
}

function rerunTarget(taskId) {
  const script = path.join(root, 'scripts', 'agent_queue_guard.mjs');
  const child = spawnSync(process.execPath, [script, 'target-once', '--task', taskId], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`FEATURE_CONTRACT_RERUN_EXIT:${child.status ?? 1}`);
}

function main() {
  const taskId = String(arg('task', '')).trim();
  if (!/^TASK-[A-Za-z0-9-]+$/.test(taskId)) throw new Error(`FEATURE_CONTRACT_TASK_ID_INVALID:${taskId || 'missing'}`);
  let current = taskRow(taskId).row;
  if (!isFeatureContractTask(current)) {
    console.log(`[feature-contract-retry] SKIP task=${taskId} goal=${current.goalId || 'none'}`);
    return;
  }

  for (let repair = 0; repair <= MAX_REPAIRS; repair += 1) {
    current = taskRow(taskId).row;
    try {
      const result = validateCurrent(current);
      normalizeCompletedMetadata(taskId);
      console.log(`[feature-contract-retry] PASS task=${taskId} result=${result.resultId} repairs=${repair}`);
      return;
    } catch (error) {
      const message = String(error?.message || error);
      if (repair >= MAX_REPAIRS) {
        rollbackForRepair(taskId, message, repair + 1);
        throw new Error(`FEATURE_CONTRACT_INVALID_AFTER_REPAIRS:${message}`);
      }
      rollbackForRepair(taskId, message, repair + 1);
      rerunTarget(taskId);
    }
  }
}

main();
