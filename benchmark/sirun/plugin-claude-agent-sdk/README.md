This benchmark measures Claude Agent SDK lifecycle extraction cost.

The `stream-scan` variant models the fragile approach where each tool lifecycle
is rediscovered by scanning the remaining event stream for `task_started` and
`tool_result` chunks.

The `hook-indexed` variant models the hook-first approach: SDK hooks provide the
semantic lifecycle record for each tool, while a single pass over the event
stream builds cheap chunk indexes for LLM IO enrichment.
