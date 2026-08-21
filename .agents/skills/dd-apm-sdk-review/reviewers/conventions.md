MUST READ FIRST: [_common.md](./_common.md) — do not review without it.

# Reviewer: Codebase conventions

Your question: **does this match how `dd-trace-js` actually does things?**

Not how the language does things in general, and not your preferences — how *this repo* does it. Your authority is the repo's own documented rules and its existing code.

## The repo's stated rules

Convention docs:

- `AGENTS.md` (repo root) — authoritative: setup/package-manager policy, testing instructions, code style, import ordering, ECMAScript/Node target, event handlers, performance & memory rules, logging, error handling, architecture-decision scoring, backportability, public TS types, config-option checklist, instrumentation/plugin creation, debugging failures, PR/CI rules, flaky-test policy, vendoring.
- `CLAUDE.md` (root) — one line, `See @AGENTS.md`.
- `CONTRIBUTING.md` — small PRs, be descriptive, avoid large refactors, test everything, benchmarks, backportability + `DD_MAJOR` guard example, semver label definitions, `only-land-on-next`, all-green policy.
- `.agents/skills/apm-integrations/SKILL.md` (+ `references/`) — instrumentation/plugin architecture and rules.
- `.agents/skills/llmobs-integration/SKILL.md`, `.agents/skills/llmobs-testing/SKILL.md`, `.agents/skills/serverless-integrations/SKILL.md`.
- `docs/API.md` (public option/plugin docs), `index.d.ts` / `index.d.v5.ts` (public types), `docs/test.ts` (type smoke test).
- `eslint.config.mjs` + `eslint-rules/` — mechanically enforced style.
- `.github/pull_request_template.md`, `.github/workflows/pr-title.yml` (PR title/label contract).

**Read those files as part of this review.** They are the specification you are reviewing against. If a rule there contradicts your instinct, the rule wins. Quote the rule you're invoking when you report a finding.

## Mechanical checks — run these, don't eyeball them

Check-mode only. Anything below that would rewrite files is the author's to run, not yours; if a check fails, report it.

Read **AGENTS.md § "Code Style & Linting"** for the style rules and the lint entry points, then run them against the changed files.

```bash
npm run lint        # check_licenses + check-no-* + eslint --max-warnings 0 + codeowners audit + verify-exercised-tests
npm run type:check  # tsc --noEmit -p tsconfig.dev.json
./node_modules/.bin/eslint --no-warn-ignored --max-warnings 0 <changed .js/.mjs/.ts files only>
# --no-warn-ignored matters: without it, passing a .md or other ignored file makes
# eslint exit nonzero on "File ignored because no matching configuration was
# supplied", so a docs- or agent-file-only change can never review clean.
```

Generated-artifact verifiers CI runs, which a config or plugin change can break:
```bash
npm run verify:config:types            # scripts/generate-config-types.js --check
npm run verify:supported-integrations
npm run verify:electron-package
npm run verify:workflow-job-names
npm run test:eslint-rules              # eslint-rules/*.test.mjs
```
Config is `eslint.config.mjs` plus the local rules in `eslint-rules/`. Note markdown is not covered by eslint, but `.editorconfig` is enforced by a checker in CI - `indent_size = 2`, so odd-numbered indentation fails.

Run the check-only forms above. Any formatter or code generator that rewrites files is the author's to run, not the reviewer's - report the failure instead.

Report the actual output. If a command fails to run (missing toolchain, missing deps), report `NOT VERIFIED (<reason>)` for that check rather than assuming the code is clean or dirty.

## Checks

- **Lint / format / type clean** on the changed files, per the commands above.
- **File placement and naming.** Does a new file live where this repo puts that kind of file, with the naming pattern this repo uses? Compare against the nearest existing sibling, not against a generic idiom.
- **Prior art.** Find the most similar existing code in the repo and compare structure. Deviating from an established local pattern without reason is a P1. Name the file you compared against.
- **Config options.** Is a new option registered through this repo's own registration path, named per its `DD_*` conventions, documented, and given telemetry where the repo does that? Bypassing the registry is P0: it silently breaks precedence, validation, and config telemetry. The path is:

Read **AGENTS.md § "Adding New Configuration Options"** - it lists the required steps and the file for each. Do not restate them from memory; open the section and check the diff against it.

Only the parts AGENTS.md does not state:
- `packages/dd-trace/src/config/generated-config-types.d.ts` is generated; regenerate/verify with `npm run generate:config:types` / `npm run verify:config:types`. A stale generated file fails CI.
- Naming: size/time options carry unit suffixes (`timeoutMs`, `maxBytes`, `intervalSeconds`).
- A missing `supported-configurations.json` entry is a CI failure, not a nit - so a diff that reads a new `DD_*` var without registering it is Blocking.
- **Span/tag/metric naming.** Does new instrumentation follow this repo's naming patterns for operation names, service names, resource names, span kinds, and tag keys? Compare against an existing integration in this repo.
- **Error/logging conventions.** Does the change use the repo's logger, log levels, and error-wrapping idioms rather than language defaults?
- **Test conventions.** Right framework, right directory, right helpers, right fixture style, right naming. Does it use the repo's existing test utilities instead of hand-rolling setup?
- **Imports and visibility.** Import ordering/grouping per repo style; internal vs public symbol placement; no reaching into another module's private namespace.
- **Build and CI wiring.** New files, tests, or integrations that need to be registered somewhere (build list, test matrix, integration registry, package manifest, CODEOWNERS) — is that registration present? Missing wiring means the code silently never runs, which is P0.
- **Commit and PR hygiene** as this repo requires:

Read **AGENTS.md § "Pull Requests and CI"** and its subsections "Commit Messages", "PR Requirements", and "Flaky tests", plus **§ "Always Consider Backportability"**. Those own the title format and allowed types, the semver label rules, the PR template, the all-green policy, the flaky-test policy, and the `DD_MAJOR` guard for breaking changes.

Only the parts not stated there:
- `.github/workflows/pr-title.yml` (`PR_TITLE_PATTERN`) is what actually gates the title, and it auto-syncs the type/scope/semver labels - so a wrong title produces a wrong release label. Its accepted set is wider than the list in AGENTS.md (it also allows `style` and `build`). Treat the workflow as the enforced gate and AGENTS.md as the house preference: a title the workflow accepts is not a finding, but flag the divergence itself as P2 so one of the two gets fixed.
- `only-land-on-next` is applied by hand for changes that must not land on stable release lines (CONTRIBUTING.md, "Indicate intended release targets").
- There is no changelog file in this repo: the PR title is the release note. Audit the title and labels rather than asking for a changelog entry.
- No in-repo rule mandates `gh --repo` flags or a fork-vs-branch policy; do not invent one.

## Do not

- Do not invent conventions that do not exist in the repo.
- Do not report a "violation" without either a quoted rule or a named existing file that does it differently.
- Do not duplicate the design reviewer's architectural judgments.
