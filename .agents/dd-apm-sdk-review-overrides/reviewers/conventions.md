Override for `reviewers/conventions.md` (in the core skill folder) — read that file first, then this.

# Codebase conventions — dd-trace-js specifics

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

## Mechanical checks — run these, don't eyeball them

Check-mode only. Anything below that would rewrite files is the author's to run, not yours; if a check fails, report it.

Read **AGENTS.md § "Code Style"** for the style rules and the lint entry points, then run them against the changed files.

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

## Config options — registration path

Read **AGENTS.md § "Cross-Cutting Configuration Changes"** - it lists the required steps and the file for each. Do not restate them from memory; open the section and check the diff against it.

Only the parts AGENTS.md does not state:
- `packages/dd-trace/src/config/generated-config-types.d.ts` is generated; regenerate/verify with `npm run generate:config:types` / `npm run verify:config:types`. A stale generated file fails CI.
- Naming: size/time options carry unit suffixes (`timeoutMs`, `maxBytes`, `intervalSeconds`).
- A missing `supported-configurations.json` entry is a CI failure, not a nit - so a diff that reads a new `DD_*` var without registering it is Blocking.

## Commit and PR hygiene

Read **AGENTS.md § "Pull Requests and CI" → "Commit Messages"** for the title format, allowed types, PR template usage, and all-green policy; **§ "Debugging Failures"** for the flaky-test handling policy; and **§ "Backportability and Runtime Support"** for Node.js compatibility rules. The `DD_MAJOR` guard example lives in `CONTRIBUTING.md`, not `AGENTS.md`.

Only the parts not stated there:
- `.github/workflows/pr-title.yml` (`PR_TITLE_PATTERN`) is what actually gates the title, and it auto-syncs the type/scope/semver labels - so a wrong title produces a wrong release label. Its accepted set is wider than the list in AGENTS.md (it also allows `style` and `build`). Treat the workflow as the enforced gate and AGENTS.md as the house preference: a title the workflow accepts is not a finding, but flag the divergence itself as P2 so one of the two gets fixed.
- `only-land-on-next` is applied by hand for changes that must not land on stable release lines (CONTRIBUTING.md, "Indicate intended release targets").
- There is no changelog file in this repo: the PR title is the release note. Audit the title and labels rather than asking for a changelog entry.
- No in-repo rule mandates `gh --repo` flags or a fork-vs-branch policy; do not invent one.
