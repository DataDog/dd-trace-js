This benchmark measures Claude Agent SDK lifecycle extraction cost.

The `stream-scan` variant models the fragile approach where each tool lifecycle
is rediscovered by scanning the remaining event stream for `task_started` and
`tool_result` chunks.

The `hook-indexed` variant models the hook-first approach: SDK hooks provide the
semantic lifecycle record for each tool, while a single pass over the event
stream builds cheap chunk indexes for LLM IO enrichment.

The hook-indexed variant rebuilds the stream index inside each measured
operation. This charges the hook-first approach for the per-trace indexing pass
instead of benchmarking only Map lookups against repeated stream scans.

Two stream shapes are covered:

- `compact`: `task_started` and `tool_result` chunks are adjacent to each
  tool use. This is the best case for repeated stream scanning.
- `delayed-noisy`: tool lifecycle chunks are delayed until later in the turn
  and separated by unrelated assistant chunks. This models larger agent traces
  where reconstructing lifecycle from the stream repeatedly has to cross
  unrelated LLM/subagent output.
