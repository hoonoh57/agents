# Research Tool Contract

## Tool: `RUN_FEATURE_EXPERIMENT`

Purpose: execute one existing trigger with one parameter set against a frozen local research dataset.

Allowed semantic arguments are defined by `registry/research_tools.json`:

- `featureId`: one of the tool registry's `allowedFeatureIds`.
- `period`: an integer satisfying the registered parameter contract.
- Parameter values must be derived from the assigned human goal; do not copy or invent a default period.

Use this tool when the goal asks for one already-specified parameter set.

## Tool: `RUN_FEATURE_PERIOD_SEARCH`

Purpose: search a bounded moving-average period range without repeatedly exposing the chronological Validation holdout.

Semantic arguments:

- `featureId`: one of the tool registry's `allowedFeatureIds`.
- `periodMin`: inclusive lower bound from the human goal.
- `periodMax`: inclusive upper bound from the human goal.
- `periodStep`: deterministic increment from the human goal or the existing capability search contract.

Use this tool when the goal asks to compare a range of periods rather than one fixed period.

Method contract is runtime/tool owned and must not be altered by the agent:

- Rank all legal periods using Discovery evidence only.
- Freeze exactly one top Discovery candidate before Validation.
- Evaluate Validation only for that frozen candidate.
- Never evaluate or request Validation for non-selected periods.
- Do not rerun the range with a changed ranking rule after seeing Validation.
- The tool returns `BEST_VALIDATED`, `NO_GO_VALIDATION`, `NO_GO_NO_VALIDATION_EVENTS`, or `NO_GO_NO_DISCOVERY_EVENTS` according to its frozen gate.

## Common boundaries

- Dataset identity, date range, outcome horizon, and outcome thresholds are supplied by runtime tool context and cannot be changed by the agent.
- Tools are read-only and cannot send orders or mutate broker state.
- Tool result schema is `ResearchToolEvidence@1.0.0`.
- `profitabilityClaim` must remain false.
- The model chooses only semantic tool intent and arguments. Runtime owns action ids, canonical action envelopes, timestamps, evidence ids, and evidence reference envelopes.
- The agent must never invent tool evidence. If tool evidence is missing, request the minimum allowed action or return BLOCKED.
