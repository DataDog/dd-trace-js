# Step 10: validate_app

- Type: deterministic
- Objective: Validate sample app artifact and generate CI service requirements from docker-compose.

## Existing Workflow Guidance

Fast deterministic step. Checks sample app file exists, saves it as a named artifact,
and generates CI config (GitHub Actions / GitLab CI) for any required Docker services.
The CI config artifact is consumed by compile (dd-generate) to wire up integration tests.

Not meaningful for Java — skip alongside generate_app and context_mapping:
  --skip generate_app validate_app context_mapping

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
