# Research Factory Rules

```text
IDEAS MAY BE UNLIMITED.
RESEARCH METHODS MAY BE UNLIMITED.
IMPLEMENTATION CAPABILITIES MAY GROW.
EXECUTION REMAINS EVIDENCE-BOUND.
```

Mandatory rules:

```text
No agent output becomes READY merely because an LLM produced it.
No patch-until-PASS research.
No hypothesis mutation during evaluation.
No silent deletion of failed experiments.
No future leakage.
No repeated optimization against the final holdout.
No sophistication bonus for ML/DL.
No broker/order action from research agents.
No secret/API/account credentials in Git.
No generated code execution without normal build/test/validation gates.
No agent may directly rewrite another agent's workspace; cross-agent work is assigned through Coordinator tasks.
```

## Local LLM runtime isolation

The trading/chart runtime has priority over research. Local LLM research must never be designed as a resident 24-hour process.

```text
DURABLE QUEUE MAY EXIST 24 HOURS.
LOCAL LLM RESIDENCY MUST NOT.
```

Production research execution rules:

- Local LLM work is one-shot and background-scheduled after the configured research-window start (default 20:00 KST).
- The default research window ends at 06:00 KST so resources are released well before live-market operation.
- At most one local LLM research task may execute concurrently.
- No polling loop may keep a research worker or model resident while waiting for work.
- If the queue is empty, no model is loaded.
- After a one-shot run, configured Ollama models must be unloaded immediately and the worker process must exit.
- Research scheduling must not start or stop the broker, chart, trading gateway, or main trading application.
- Live trading/chart processes are never preempted for research throughput.

Every adopted feature must preserve:

```text
exact lineage
exact executable definition/version
exact validation evidence
exact baseline improvement delta
exact chart-traceable SignalEvents where applicable
```

Negative evidence is a valid result. `REJECTED_WITH_EVIDENCE` is a successful research outcome when it prevents repeated dead-end work.
