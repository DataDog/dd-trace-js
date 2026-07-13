# Step 6: review

- Type: deterministic
- Objective: Interactive TUI for reviewing and overriding agent-selected instrumentation targets.

## Existing Workflow Guidance

Automatically skipped in: --mode=agent, --headless, workspace/remote (DD_APM_REMOTE) mode.
In guided mode, opens a curses-based terminal UI showing agent targets alongside all
available methods. Users can add, remove, or disable targets before the final merge.
Selections are saved to the 'overrides' artifact and folded in by merge_layers.
If the TUI crashes or renders incorrectly, check terminal size (must be at least 80x24)
and that $TERM is set to a curses-compatible value.

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
