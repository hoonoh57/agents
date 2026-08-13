# Agent Workspaces

This directory is generated from `registry/agents.json`.

Each logical agent owns a durable workspace. Re-run `node scripts/bootstrap_agent_workspaces.mjs` after adding an agent to the registry. Existing files are preserved unless `--force` is supplied.
