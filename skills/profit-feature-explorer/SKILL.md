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

Map the human goal to the capability whose trigger semantics match it, then derive parameter values from the goal text. Do not substitute MA-versus-MA logic for price-versus-MA logic. Do not invent parameter values that the goal did not specify.
