# Verification

All paths here are relative to this control bundle. Create one directory per stage
(`evidence/01/`, `evidence/02/`, and so on). Evidence is local run state and is gitignored.
Do not create `.dd-apm-evidence` or another evidence tree elsewhere in the repository, and do
not add evidence to the product pull request.

Each stage must produce a reviewable `summary.md` of at most 200 lines and 20 KB containing:

- source revision and relevant changed files;
- exact commands, exit status, and a concise result excerpt;
- paths and SHA-256 hashes for larger artifacts;
- expected versus observed behavior, blockers, and the next decision;
- trace or CI URLs and stable IDs when remote evidence exists.

Put full logs, dependency inventories, lockfiles, snapshots, and captured traces or telemetry
in `evidence/<step>/raw/`. Never paste those files into `summary.md`, `PROGRESS.md`, another
stage prompt, or the implementation diff. Later agents read the summary first and inspect a
raw artifact only when its receipt identifies a specific unresolved question.

For observability gates, record the sample-app command, trace IDs or query URL, expected and
observed span names/tags/hierarchy, error behavior, and duplicate-span count. A full trace
dump is not a review artifact. Prose claims without inspectable evidence do not satisfy gates.
