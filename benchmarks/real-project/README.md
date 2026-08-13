# Real-Project Local Model Benchmark

This benchmark selects local LLM roles using the actual `kiwoom-autotrade-template` repository rather than synthetic general-knowledge questions.

The finalists are `qwen3.6:35b-a3b` (quality-first) and `gemma4:12b` (lighter operational candidate). `gpt-oss:20b` remains excluded until its local Ollama artifact can load.

The benchmark runs three tasks: `EXPLORER-CONTRACT-001` reads the current Explorer catalog/integration contracts; `RESEARCH-CAUSALITY-001` reads the current Foundry source/live regression test; `CODER-REPAIR-001` creates a detached worktree, injects one controlled regression, asks the model for an exact repair, and runs the real existing regression test.

Each task stores semantic score and structured-output contract score separately. `quality = 0.8 * semantic + 0.2 * contract`. The coding task receives semantic credit only when the model patch is applicable and the real repository test passes.

The target repository working tree is never edited. Broker actions are never invoked. Model output is not profitability evidence and cannot bypass normal Explorer/OOS validation gates.
