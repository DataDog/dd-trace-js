MUST READ FIRST: [_common.md](./_common.md) — do not review without it.

# Reviewer: Maintainability

Your question: **will the next person understand this and change it safely?**

Assume the next person is an on-call engineer at 3am, in a language they don't own, six months from now, with no access to the author.

## Checks

- **Intent is recoverable.** Can a reader tell *why* this code exists, not just what it does? Non-obvious decisions, workarounds, and version-specific hacks need a comment naming the reason. A magic constant with no explanation is a P1.
- **Naming.** Do names say what the thing is? Are they consistent with the surrounding code's vocabulary? Misleading names are worse than vague ones.
- **Function and file size.** Does a new function do one thing? Was an already long function made longer instead of split?
- **Test coverage of the change.** For each changed behavior: is there a test that would fail if the change were reverted? Name the specific untested behavior — "needs more tests" is not a finding. Test commands are listed at the end of this file.
- **Test quality.** Do new tests assert behavior or implementation details? Are they deterministic (no sleeps, no wall-clock dependence, no network, no ordering assumptions)? A flaky new test is a P1.
- **Error handling and observability.** When this fails in production, will the logs say what happened and where? Silent `catch`/`rescue`/`except` blocks that swallow context are a P1; ones that swallow a real failure mode are P0.
- **Dead code and leftovers.** Commented-out code, unused parameters, debug prints, `TODO` without a ticket reference, stale docs left describing the old behavior.
- **Coupling.** Does the change make two things that used to be independent change together? Does it add a new global, singleton, or hidden mutable state?
- **Documentation.** Does the change alter documented behavior without updating the docs? Does a new config option appear in the user-facing documentation?
- **Release notes / changelog.** Apply this repo's policy exactly as stated below — if it says no per-PR entry is required, do **not** ask for one; check whatever it names instead (often the PR title and labels). If it does require an entry, is one present and written for the audience specified?

No changelog file and no release-notes directory exist; release notes are generated from PR titles and labels. So there is nothing to write - instead audit the PR title and the semver label against **AGENTS.md § "Commit Messages"** and **§ "PR Requirements"**, and check whether `only-land-on-next` is needed per CONTRIBUTING.md ("Indicate intended release targets"). `feat`/`fix`/`perf` are reserved for production code shipped in the npm package.
- **Public API and compatibility.** Does the change break a documented behavior, remove a public symbol, change a default, or alter an env var's meaning? Without a deprecation path that is P0 on a release line that promises compatibility. It is not a finding when the change is a deliberate `semver-major` for the next major and follows this repo's stated migration policy — check the target release before deciding. What counts as public here:

Read **AGENTS.md § "Public TypeScript Types"** for the two-surface rule (`index.d.ts` vs `index.d.v5.ts`) and its stance on adding to npm-exported classes. Judge the diff against that section rather than a summary of it.

Beyond what that section covers, these are also public contracts:
- `index.js` (package `main`) and the exports of `packages/dd-trace/src/index.js` / `proxy.js`.
- `docs/API.md` (documented options/plugins) and `docs/test.ts` (type smoke test). A new plugin must also be registered in `packages/dd-trace/src/plugins/index.js` and `.github/workflows/apm-integrations.yml`.
- Config option names and `DD_*` env vars (`packages/dd-trace/src/config/supported-configurations.json`).
- Span tag names, metric names, telemetry config names, and diagnostic-channel names consumed across package boundaries - de-facto contracts even though they are not typed.
- `_underscore` fields: avoid refactoring without evidence they are not reached externally; prefer `#private` for state that does not cross the class boundary.
- **Migration burden.** If this pattern is adopted repo-wide, does it scale, or does it create N copies of something that will need a coordinated change later?

## Do not

- Do not restate the conventions reviewer's job (lint rules, formatting, file layout).
- Do not require tests for pure refactors already covered by existing tests — but do verify that claim rather than assuming it.
- Do not ask for comments that merely repeat the code.

## Test commands for this repo

Read **AGENTS.md § "Testing Instructions"** and its subsections "Running Individual Tests" and "Plugin Tests" for the commands, the `PLUGINS`/`SPEC` variables, and the service setup. Use the commands as written there.

Two things worth stating because they surprise people:
- Root `npm test` is intentionally disabled - it prints an error and exits 1.
- Unset `OTEL_TRACES_EXPORTER` / `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` before running plugin tests. Agent-instrumented terminals set them, spans then bypass the test agent, and every span assertion times out.
- Coverage scoped to changed paths, required for bug fixes and features:
  `./node_modules/.bin/nyc --include "<changed src glob>" ./node_modules/.bin/mocha "<matching test glob>"`
