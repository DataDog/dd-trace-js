# Plugin integration tests on Bun

The Mocha host, fixture installation and fake agents run on Node. Setting
`DD_TEST_RUNTIME=bun` switches application forks in the integration-test spawn
helpers to the Bun binary pinned in `package.json` (`integration-tests/helpers/bun.js`).
The helpers preserve fork IPC and piped stdout/stderr. Loader/import/require
options become Bun `--preload` arguments; the tracer's loader/register entrypoints
map to `initialize.mjs`. Non-tracer custom loaders fail explicitly rather than
silently running without them. With the switch unset, Node fork options are unchanged.

## Run

From the repository root, with a supported Node version and Docker:

```sh
unset SPEC SERVICES OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
export PLUGINS='express|http|fetch|pino|openai|winston|crypto|dns'
VCR_CI_MODE=true docker compose up -d testagent
npm run services
npm run test:integration:bun:harness
npm run test:integration:plugins:bun
```

`npm run test:integration:plugins` runs the same specs on Node with the switch unset.
The Bun script reuses the existing plugin spec glob, including `PLUGINS` and `SPEC`.
It does not reinstall fixtures on each run; run `npm run services` first.

The Instrumentation workflow runs five Bun shards covering the list above. OpenAI
is split by a test-title filter and its inverse, so new cases cannot fall between
the shards. These
plugins need no database or message broker. OpenAI uses the existing test-agent VCR
cassettes, not a live API. Other service-backed plugins can use the same harness
once their services and Bun results have been reviewed; they are not yet in this job.

## Known failures

`known-failures.json` is keyed by repository-relative spec file and **full Mocha
test title**, including dependency version and import variant. Every listed test
still executes. A failure in its test body is reported as pending with
`known Bun failure` and its reason. An unexpected pass fails the run and instructs
the developer to remove the entry. Unlisted failures and setup/teardown failures
remain failures. Explicit skips remain skips, not proof that a known failure is fixed.

To regenerate the baseline, run the complete `PLUGINS` list above, without `SPEC`:

```sh
npm run generate:bun-plugin-failures
```

Generation disables expected-failure inversion and replaces entries for exercised
spec files with observed test-body failures, preserving entries for other files.
It records the original failure rather than secondary multiple-done errors. Its
exit status is Mocha's raw status (nonzero when tests fail).
It refuses to write a baseline if any setup/teardown hook failed. Review every new
entry; do not baseline infrastructure failures. A filtered run replaces whole
spec-file entries, so use the complete list without `--grep` when regenerating.
Dependency updates can change full titles and therefore require baseline review.

The reporter prints a final count of spec files, passes, known failures, other
pending tests and unexpected failures. Logs and original assertions remain visible.
No runtime fixes or compilation bridges are applied by this harness.
