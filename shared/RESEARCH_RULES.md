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

Every adopted feature must preserve:

```text
exact lineage
exact executable definition/version
exact validation evidence
exact baseline improvement delta
exact chart-traceable SignalEvents where applicable
```

Negative evidence is a valid result. `REJECTED_WITH_EVIDENCE` is a successful research outcome when it prevents repeated dead-end work.
