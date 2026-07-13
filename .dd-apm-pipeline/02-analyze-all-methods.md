# Step 2: analyze > all_methods

- Type: deterministic
- Objective: Extract all exported methods from the package via static analysis.

## Existing Workflow Guidance

Fast deterministic step. Runs the repo adapter's method extractor script.
Output feeds: (1) the TUI review step (user can select/deselect targets),
(2) the agent_analysis prompt (agent sees full method list as reference).

Language-specific:
- JS: runs an AST-based extractor, handles CJS + ESM exports
- Python: runs ast-based extractor
- Java: runs a JAR bytecode extractor via javap when Maven coordinates install a JAR

If extraction produces 0 methods, check that install_package succeeded and
that the package has a standard export structure. For Java, check that
Maven coordinates were provided and resolved to the binary JAR, not a
sources or javadoc classifier.

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
