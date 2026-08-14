# Research Tool Contract

## Tool: `RUN_FEATURE_EXPERIMENT`

Purpose: execute one existing trigger with one parameter set against a frozen local research dataset.

Allowed arguments:

```json
{
  "featureId": "PRICE_MA_RECLAIM_UP",
  "parameters": { "period": 5 }
}
```

Current P0 limits:

- `featureId` must be `PRICE_MA_RECLAIM_UP`.
- `period` must be an integer from 2 through 240.
- Dataset identity, date range, outcome horizon, and outcome thresholds are supplied by runtime tool context and cannot be changed by the agent.
- The tool is read-only and cannot send orders or mutate broker state.

Tool result schema: `ResearchToolEvidence@1.0.0`.

Evidence contains all/discovery/validation summaries, event counts, validation start, dataset hash, effective population, exclusions, and `profitabilityClaim:false`.

The agent must never invent tool evidence. If tool evidence is missing, request the action or return BLOCKED.
