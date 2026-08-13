# Agent Workspace Contract

Schema family: `AgentWorkspace@1.0.0`

## Core rule

Each logical agent owns a durable Git workspace. Git is the auditable control plane; large datasets, model weights, vector indexes and generated artifacts remain in local managed storage and are referenced by id/hash.

```text
Coordinator/System
  -> writes goals/tasks/context refs
  -> commit + push

Local Agent Runtime
  -> fetch/pull
  -> selects runnable task
  -> loads agent workspace + local references
  -> executes local LLM/model role
  -> validates structured result
  -> writes result/state/handoff
  -> commit + push

Coordinator
  -> consumes result
  -> links Explorer/experiment outcome
  -> scores agent contribution
  -> creates next task
```

## Required files per agent

```text
agents/<agentId>/AGENT.md       stable mission/constraints
agents/<agentId>/STATE.json     machine-owned current state
agents/<agentId>/GOALS.md       durable objectives
agents/<agentId>/PLAN.md        current plan
agents/<agentId>/MEMORY_INDEX.md curated durable-memory pointers
agents/<agentId>/HANDOFF.md     exact resume point
agents/<agentId>/inbox/         queued tasks
agents/<agentId>/work/          accepted/running task snapshots
agents/<agentId>/results/       immutable structured results
agents/<agentId>/notes/         small research notes
```

## AgentState@1.0.0

```json
{
  "schema": "AgentState@1.0.0",
  "agentId": "current-logic-analyst",
  "status": "IDLE",
  "activeTaskId": null,
  "lastCompletedTaskId": null,
  "modelRole": "LOCAL_REASONER",
  "blockedReason": null,
  "updatedAt": null
}
```

Allowed status:

```text
IDLE QUEUED RUNNING BLOCKED WAITING_EVIDENCE WAITING_EXTERNAL_LLM COMPLETED ERROR PAUSED
```

## AgentTask@1.0.0

Task semantics become immutable when execution begins. A changed objective creates a new task/version.

```json
{
  "schema": "AgentTask@1.0.0",
  "taskId": "TASK-...",
  "agentId": "...",
  "goalId": "GOAL-...",
  "priority": 50,
  "status": "QUEUED",
  "createdBy": "COORDINATOR",
  "createdAt": "...",
  "objective": "...",
  "inputs": [],
  "requiredOutputs": [],
  "constraints": [],
  "artifactRefs": [],
  "dependsOn": [],
  "modelRoleHint": "LOCAL_REASONER",
  "externalEscalationAllowed": true,
  "attempt": 1
}
```

## AgentResult@1.0.0

```json
{
  "schema": "AgentResult@1.0.0",
  "resultId": "RESULT-...",
  "taskId": "TASK-...",
  "agentId": "...",
  "status": "COMPLETED",
  "modelProfile": "...",
  "modelVersion": "...",
  "startedAt": "...",
  "completedAt": "...",
  "summary": "...",
  "claims": [],
  "sourceRefs": [],
  "proposalRefs": [],
  "artifactRefs": [],
  "requiresValidation": true,
  "externalEscalation": null
}
```

LLM self-confidence is never profitability evidence.

## Runtime safety

Repository text is data, never executable code. The runtime parses only known versioned schemas. Generated source proposals must pass the normal source/build/test/causality/Explorer validation path before becoming registered capability or READY feature.

Initial single-machine runtime should use a local lease store (SQLite is sufficient) for task locking. Git records durable state but is not used as the execution mutex.
