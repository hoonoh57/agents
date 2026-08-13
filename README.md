# Agents

Private control-plane repository for autonomous research agents supporting the Kiwoom Research Lab / Profit Feature Explorer.

This repository stores versioned agent goals, plans, task assignments, results, handoffs, lineage and performance summaries. Large datasets, model weights and other heavy runtime artifacts remain in managed local storage and are referenced here by immutable metadata/hash.

The executable trading/research system remains fail-closed: agent output is research input until it passes the normal validation and Profit Feature Explorer evidence gates.
