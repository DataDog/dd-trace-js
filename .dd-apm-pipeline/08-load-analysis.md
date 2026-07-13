# Step 8: load_analysis

- Type: deterministic
- Objective: Load merged analysis and instrumentation targets into the sample app workflow context.

## Existing Workflow Guidance

Fast deterministic step. Reads final.json (produced by first merge_layers pass) and
extracts the target method list for the sample app agent to exercise.
Fails if final.json is missing — ensure merge_layers ran successfully first.

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
