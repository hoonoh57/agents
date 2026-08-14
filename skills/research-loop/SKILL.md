# Autonomous Research Loop

## Purpose

Convert a human research goal into evidence-bound tool actions, read the resulting evidence, and stop only with an explicit COMPLETE or BLOCKED state.

## Mandatory loop

1. Read the GOAL and success criteria.
2. Read the available capability/tool contracts before proposing implementation.
3. Choose the smallest existing deterministic tool that can test the goal.
4. If execution is required, return `ACTION_REQUIRED`; do not invent results.
5. Runtime executes only whitelisted tools and returns `ResearchToolEvidence`.
6. Read the evidence and decide whether another allowed action is necessary.
7. Return `COMPLETE` when the requested question has been answered by evidence.
8. Return `BLOCKED` when the goal cannot be answered with the available capabilities or evidence.

## Research discipline

- Reasoning freedom does not imply execution freedom.
- Never execute broker/order actions.
- Never mutate the hypothesis after seeing the outcome.
- Never turn LLM confidence into a profitability claim.
- Preserve failed and negative evidence.
- Prefer an existing capability over asking for new code.
- Tool arguments must be derived from the goal and capability semantics, not from desired outcomes.

## P0 smoke-test rule

For the first autonomous smoke test, exactly one deterministic tool action is expected before COMPLETE. The purpose is to verify the loop itself, not to optimize the strategy.
