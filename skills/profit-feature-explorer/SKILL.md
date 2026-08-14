# Profit Feature Explorer Capability

## Purpose

Use existing chart-traceable trigger capabilities before proposing new feature code.

## Current trigger capabilities

### `MA_FRESH_CROSS_UP`

Fresh moving-average cross. D-1 fast MA <= slow MA and D fast MA > slow MA.

Parameters: `fast`, `slow`.

### `PRICE_MA_RECLAIM_UP`

Fresh price reclaim of a moving average. D-1 close <= D-1 MA and D close > D MA.

Parameter: `period` (integer).

Existing Explorer search contract for this capability: period 5 through 120 in steps of 5.

### `PRICE_N_HIGH_BREAKOUT`

Fresh close breakout above the previous N-session high.

Parameter: `lookback` (integer).

## Common outcome semantics

- Decision uses completed D information only.
- Entry is next trading session open (D+1 open).
- Outcome horizon and positive/negative thresholds come from the frozen dataset/tool context.
- Signal events must be reproducible and chart traceable.
- A feature result may be negative; negative evidence is valid.

## Translation rule

Map the human goal to the capability whose trigger semantics match it, then derive parameter values or search bounds from the goal text and existing capability contract. Do not substitute MA-versus-MA logic for price-versus-MA logic. Do not invent parameter values that the goal did not specify.

When the goal asks to compare an MA period range, prefer the registered holdout-safe period-search tool over issuing many single-period experiment actions. This preserves one candidate freeze and one chronological Validation evaluation while keeping Local LLM usage short.
