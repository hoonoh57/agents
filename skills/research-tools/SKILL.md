# Research Tool Contract

## Tool: `RUN_FEATURE_EXPERIMENT`

Purpose: execute one existing trigger with one parameter set against a frozen local research dataset.

Allowed semantic arguments are defined by `registry/research_tools.json`:

- `featureId`: one of the tool registry's `allowedFeatureIds`.
- `period`: an integer satisfying the registered parameter contract.
- Parameter values must be derived from the assigned human goal; do not copy or invent a default period.

Current P0 limits:

- `featureId` must be an allowed registered feature.
- `period` must satisfy the registered integer bounds.
- Dataset identity, date range, outcome horizon, and outcome thresholds are supplied by runtime tool context and cannot be changed by the agent.
- The tool is read-only and cannot send orders or mutate broker state.

Tool result schema: `ResearchToolEvidence@1.0.0`.

Evidence contains all/discovery/validation summaries, event counts, validation start, dataset hash, effective population, exclusions, and `profitabilityClaim:false`.

The model chooses only semantic tool intent and arguments. Runtime owns action ids, canonical action envelopes, timestamps, and evidence reference envelopes.

The agent must never invent tool evidence. If tool evidence is missing, request the action or return BLOCKED.
