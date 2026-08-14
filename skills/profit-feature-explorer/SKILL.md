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

## Goal translation examples

Human goal: `종가가 5일 이동평균을 상향 돌파하는 경우를 분석하라.`

Correct capability mapping:

```json
{"featureId":"PRICE_MA_RECLAIM_UP","parameters":{"period":5}}
```

Do not substitute `MA_FRESH_CROSS_UP`; that is MA-versus-MA, not price-versus-MA.
