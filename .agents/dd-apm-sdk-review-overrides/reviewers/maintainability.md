Override for `reviewers/maintainability.md` (in the core skill folder) — read that file first, then this.

# Maintainability — dd-trace-js specifics

## Release notes / changelog policy

No changelog file and no release-notes directory exist; release notes are generated from PR titles and labels. So there is nothing to write - instead audit the PR title and the semver label against **AGENTS.md § "Commit Messages"**, and check whether `only-land-on-next` is needed per CONTRIBUTING.md ("Indicate intended release targets"). `feat`/`fix`/`perf` are reserved for production code shipped in the npm package.

## Public API and compatibility

Read **AGENTS.md § "Backportability and Runtime Support"** for the requirement to update every supported public TypeScript surface (in this repo, both `index.d.ts` and `index.d.v5.ts`) for new public APIs unless the change is explicitly version-specific. For the stance on adding to npm-exported classes, see `.agents/skills/architecture-review/SKILL.md` (Module coupling dimension) - AGENTS.md does not cover that itself.

Beyond what that section covers, these are also public contracts:
- `index.js` (package `main`) and the exports of `packages/dd-trace/src/index.js` / `proxy.js`.
- `docs/API.md` (documented options/plugins) and `docs/test.ts` (type smoke test). A new plugin must also be registered in `packages/dd-trace/src/plugins/index.js` and `.github/workflows/apm-integrations.yml`.
- Config option names and `DD_*` env vars (`packages/dd-trace/src/config/supported-configurations.json`).
- Span tag names, metric names, telemetry config names, and diagnostic-channel names consumed across package boundaries - de-facto contracts even though they are not typed.
- `_underscore` fields: avoid refactoring without evidence they are not reached externally; prefer `#private` for state that does not cross the class boundary.

## Test commands for this repo

Read **AGENTS.md § "Testing"** for the commands, the `PLUGINS`/`SPEC` variables, and the service setup. Use the commands as written there.

Two things worth stating because they surprise people:
- Root `npm test` is intentionally disabled - it prints an error and exits 1.
- Unset `OTEL_TRACES_EXPORTER` / `OTEL_LOGS_EXPORTER` / `OTEL_METRICS_EXPORTER` before running plugin tests. Agent-instrumented terminals set them, spans then bypass the test agent, and every span assertion times out.
- Coverage scoped to changed paths, required for bug fixes and features:
  `./node_modules/.bin/nyc --include "<changed src glob>" ./node_modules/.bin/mocha "<matching test glob>"`
