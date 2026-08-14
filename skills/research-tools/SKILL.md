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

Use this tool only for the already-frozen MA-period experiment lineage whose Validation policy is embedded in the tool evidence.

Method contract:

- Rank all legal periods using Discovery evidence only.
- Freeze exactly one top Discovery candidate before Validation.
- Evaluate Validation only for that frozen candidate.
- Never evaluate or request Validation for non-selected periods.
- Do not rerun the range with a changed ranking rule after seeing Validation.

## Tool: `RUN_HIGH_BREAKOUT_DISCOVERY_SEARCH`

Purpose: search the existing `PRICE_N_HIGH_BREAKOUT` chart-ready trigger on development data only, without reusing previously exposed historical Validation as a new holdout.

Semantic arguments:

- `featureId`: `PRICE_N_HIGH_BREAKOUT`.
- `lookbackMin`: inclusive lower bound.
- `lookbackMax`: inclusive upper bound.
- `lookbackStep`: deterministic increment.

Method contract is runtime/tool owned:

- All currently frozen historical data through the dataset cutoff is development/Discovery data for this new hypothesis lineage.
- Rank candidates on Discovery only.
- A candidate is eligible for freezing only when the pre-registered Discovery gate passes.
- This tool never runs Validation.
- Historical data already exposed by prior experiments must not be reused as fresh Validation.
- If a candidate is frozen, return `WAITING_FOR_FRESH_VALIDATION` and require decision dates strictly after the frozen data cutoff.
- If Discovery fails its gate, return `NO_GO_DISCOVERY` and do not consume future Validation data.

## Common boundaries

- Dataset identity, date range, outcome horizon, and outcome thresholds are supplied by runtime tool context and cannot be changed by the agent.
- Tools are read-only and cannot send orders or mutate broker state.
- Tool result schema is `ResearchToolEvidence@1.0.0`.
- `profitabilityClaim` must remain false.
- The model chooses only semantic tool intent and arguments. Runtime owns action ids, canonical action envelopes, timestamps, evidence ids, and evidence reference envelopes.
- The agent must never invent tool evidence. If tool evidence is missing, request the minimum allowed action or return BLOCKED.
