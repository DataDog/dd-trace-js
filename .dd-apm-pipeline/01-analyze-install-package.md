# Step 1: analyze > install_package

- Type: deterministic
- Objective: Install the target package into a temp directory for static analysis.

## Existing Workflow Guidance

Fast deterministic step. Uses the repo adapter's package manager (npm, pip, Maven).
For Java without Maven coordinates, install is skipped gracefully — subsequent steps
that need package source (all_methods, docs_collection) also skip automatically.
Provide Maven coordinates with --maven-coords group:artifact:version for Java.

## Instructions

Install and inspect npm package `genkit@1.21.0` in an isolated temporary
directory. Record the exact resolved version and package/source location in
`PROGRESS.md`. Do not substitute the latest Genkit release. Preserve the package
source location for the method inventory and documentation stages.

Reproduce this workflow stage's stated outcome directly in the target repository.
Inspect the current repository and prior pipeline results, follow repository
standards, and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
