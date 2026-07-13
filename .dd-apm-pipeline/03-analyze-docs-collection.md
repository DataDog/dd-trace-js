# Step 3: analyze > docs_collection

- Type: deterministic
- Objective: Collect package documentation (README, API docs, npm/PyPI metadata) for the analysis agent.

## Existing Workflow Guidance

Fast deterministic step. Fetches: README.md, CHANGELOG, npm/PyPI registry metadata,
and any GitHub-hosted documentation. Saved to artifacts/docs/.

Docs are injected into the agent_analysis prompt as context. Better docs → the agent
makes better decisions about which methods are public API vs internal, which carry
meaningful semantic context (e.g. message topic), and which are worth instrumenting.

If docs_collection fails (network issue, private registry), the workflow continues —
agent_analysis falls back to source-only analysis.

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
