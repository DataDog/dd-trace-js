# CLAUDE.md

@AGENTS.md

Claude Code reads `CLAUDE.md`, not `AGENTS.md`, and only follows the
`@path/to/file` import syntax — plain Markdown links are not expanded. The
import above keeps both filenames discoverable without duplicating the
project rules: the body lives in `AGENTS.md`, and other tools that already
read `AGENTS.md` are unaffected.

This file used to be a symlink, which most tools followed transparently and
ended up loading two copies of the same content into context.
