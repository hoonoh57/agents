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

### ProjectContextInput@1.0.0

The first local-project adapter is intentionally narrow. It can read only text sources below `RESEARCH_LOCAL_ROOT`; absolute paths, hidden path segments, parent traversal, unsupported extensions and symlink escape are rejected. Resolved sources are hashed before they are placed into the model context.

```json
{
  "schema": "ProjectContextInput@1.0.0",
  "inputId": "foundry-causality",
  "root": "RESEARCH_LOCAL_ROOT",
  "path": "src/profit_feature_foundry.mjs",
  "mode": "AROUND",
  "anchor": "An ordering state is context only.",
  "beforeChars": 500,
  "afterChars": 3600,
  "maxBytes": 5000
}
```

`mode=FULL` requires the entire file to fit the explicit per-source byte limit. `mode=AROUND` extracts bounded evidence around an exact anchor. The runtime records `repositoryHead`, whole-file SHA-256, excerpt SHA-256 and byte counts in `AgentResult.sourceRefs`.

### AgentTaskTemplate@1.0.0

Audited repeatable tasks live under `task-templates/`. `agent_runtime_stable.mjs enqueue --template <file>` creates a normal immutable `AgentTask@1.0.0`; the template itself is never treated as runtime evidence.

## AgentWorkProduct@1.0.0

Local model execution is schema-constrained. The model must separate direct evidence from inference/proposal and cite only resolved `inputId` values.

```json
{
  "schema": "AgentWorkProduct@1.0.0",
  "summary": "...",
  "findings": [
    {
      "kind": "DIRECT",
      "claim": "...",
      "sourceInputIds": ["foundry-causality"]
    }
  ],
  "nextActions": ["..."],
  "profitabilityClaim": false
}
```

Unknown source ids or `profitabilityClaim=true` fail the task instead of being persisted as valid evidence.

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

Initial single-machine runtime uses atomic local file leases for task locking. Git records durable state but is not used as the execution mutex.
