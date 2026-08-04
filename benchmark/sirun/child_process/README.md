Real-world bench. With AppSec or IAST subscribed, every `child_process` exec runs
the sync wrapper: `normalizeArgs` builds the command string, a context with a
fresh `AbortController` is allocated, and the tracing channel runs start/end. The
subprocess is not spawned -- a no-op underlying op isolates the tracer's per-call
cost from fork/exec noise. Variants cover the `exec` (shell string) and
`execFile` (file + array args) argument shapes.
