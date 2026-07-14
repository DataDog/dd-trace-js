# Stage 23: collect lint failures

Date: 2026-07-14 UTC

## Result

Stage 23 found **no fixable lint, syntax, whitespace, generated-config, JSON, YAML, CODEOWNERS, or test-exercise
coverage failures** in the Genkit change set. The targeted repository ESLint command covered every changed production
or test JavaScript file relative to original base `372e5eb61c4c6a13662ad2f8780a87275b50314d`, including the currently
untracked LLMObs spec that ordinary `git diff` does not enumerate.

One repository-wide CI configuration verifier failed before reaching Genkit-specific validation. It invokes
`npm show` for every integration and npm returned `E404` for the unrelated existing package
`confluentinc-kafka-javascript`. This is classified as an external/pre-existing verifier blocker, not a Genkit lint
failure. No source, test, configuration, pipeline progress, or assertion was changed in this stage.

## Changed JavaScript inventory

The committed/uncommitted source comparison used:

```sh
git diff --name-only --diff-filter=ACMR 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**'
git status --short
```

Targeted JavaScript files:

```text
packages/datadog-instrumentations/src/genkit.js
packages/datadog-instrumentations/src/helpers/hooks.js
packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/genkit.js
packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js
packages/datadog-plugin-genkit/src/index.js
packages/datadog-plugin-genkit/src/tracing.js
packages/datadog-plugin-genkit/test/index.spec.js
packages/datadog-plugin-genkit/test/llmobs.spec.js
packages/dd-trace/src/llmobs/plugins/genkit/index.js
packages/dd-trace/src/plugins/index.js
packages/dd-trace/test/plugins/externals.js
```

`packages/datadog-plugin-genkit/test/llmobs.spec.js` was added from `git status` because it is untracked at this
stage and therefore absent from the base diff.

## Targeted ESLint

Run from `/workspace/repo` using npm, per repository policy:

```sh
npm exec -- eslint --max-warnings 0 \
  packages/datadog-instrumentations/src/genkit.js \
  packages/datadog-instrumentations/src/helpers/hooks.js \
  packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/genkit.js \
  packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js \
  packages/datadog-plugin-genkit/src/index.js \
  packages/datadog-plugin-genkit/src/tracing.js \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js \
  packages/dd-trace/src/llmobs/plugins/genkit/index.js \
  packages/dd-trace/src/plugins/index.js \
  packages/dd-trace/test/plugins/externals.js
```

Exit code: `0`. Output: empty. Result: 11 files passed with zero errors and zero warnings.

## Syntax and whitespace

Each of the 11 JavaScript files above was passed individually to `node --check`. All exited `0` with no output.

```sh
git diff --check 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**'
```

Exit code: `0`. Output: empty.

## Configuration checks

Generated configuration types:

```sh
npm run verify:config:types
```

Exit code: `0`.

```text
> dd-trace@7.0.0-pre verify:config:types
> node scripts/generate-config-types.js --check
```

JSON/YAML parsing used the installed `yaml` dependency and `JSON.parse` for the three changed configuration files:

```text
valid JSON: packages/dd-trace/src/config/supported-configurations.json
valid JSON: packages/dd-trace/test/plugins/versions/package.json
valid YAML: .github/workflows/apm-integrations.yml
```

CODEOWNERS audit:

```sh
npm run lint:codeowners:ci
```

Exit code: `0`. Relevant summary:

```text
analyzed files: 1639
unknown files: 0
oversized CODEOWNERS warnings: 0
missing path warnings: 0
invalid owner warnings: 0
owner validation warnings: 0
```

Test/workflow exercise validation:

```sh
npm run verify-exercised-tests
```

Exit code: `0`.

```text
All test files are covered by at least one package.json script glob.
All CI workflows reference valid scripts, and plugin setup looks consistent.
Test files: 799
Extracted globs: 71
```

## Non-applicable ESLint inputs

A diagnostic ESLint invocation against `docs/test.ts`, `index.d.ts`, `index.d.v5.ts`, and
`packages/dd-trace/src/config/generated-config-types.d.ts` exited `1` only because all four files are ignored or
have no matching ESLint configuration. It reported zero errors and four ignored-file warnings. These files are not
part of the repository's ESLint target surface; the generated declaration was instead validated by
`npm run verify:config:types`.

## Repository-wide CI verifier blocker

Bounded command:

```sh
timeout 45s node scripts/verify-ci-config.js
```

Exit code: `1` after 3.4 seconds. Primary output:

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/confluentinc-kafka-javascript - Not found
Error: Command failed: npm show confluentinc-kafka-javascript versions --json
    at getMatchingVersions (/workspace/repo/scripts/verify-ci-config.js:113:33)
    at checkPlugins (/workspace/repo/scripts/verify-ci-config.js:73:26)
```

Classification: `external_repository_wide_verifier_blocker`. The verifier queries all integrations and stopped on
an existing non-Genkit package lookup. The changed workflow parses as valid YAML, and
`npm run verify-exercised-tests` independently confirms that all CI workflows reference valid scripts and plugin
setup is consistent.

## Stage 24 handoff

There are no Genkit lint failures to fix. Stage 24 should be an evidence-backed no-op unless the source state
changes after this diagnosis. The unrelated registry-dependent CI verifier failure must not be hidden by changing
Genkit files.
