# Step 7: merge_layers

- Type: deterministic
- Objective: Merge agent analysis, enrichments, user overrides, and context mappings into final output.

## Existing Workflow Guidance

Deterministic and fast (~1s). Runs twice in the create workflow: once before the sample app
sub-workflow (to provide targets for context capture), and once after (to fold context
mappings into the final analysis). If merge_layers fails, check that agent analysis and
enrichment artifacts are present: .analysis/<pkg>/new_integration/artifacts/

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
