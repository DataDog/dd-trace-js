# Stage 31: final build gate

Date: 2026-07-14 UTC

## Result

**Failed.** The frozen Genkit source state passes JavaScript syntax and generated configuration-type verification,
but the required final build gate cannot pass because two canonical repository checks exit non-zero:

1. `npm run type:check` exits 2 before checking project sources because the repository's TypeScript 6 compiler
   rejects the existing `tsconfig.dev.json` options `alwaysStrict=false` and `baseUrl` unless
   `ignoreDeprecations: "6.0"` is configured.
2. `npm run verify:supported-integrations` exits 1 because `supported_versions_output.json` and
   `supported_versions_table.csv` are stale after the Genkit integration registration.

The second failure is a Genkit-owned generated-artifact failure. Stage 31 did not run the generator or modify the
stale files because any source/generated-code change during a final gate invalidates the final-gate evidence and
requires restarting at Stage 31.

No production, test, configuration, generated artifact, or pipeline progress file was modified by this stage.

## Frozen source state

```text
HEAD: 2858540854daf3a9de106a259fd99ccd7c3b8a70
Stage 30 source diff SHA-256: 7ae72584fa94013b2e3db0f5bc465064a81aa77560d4978261b6a54559bf3abd
Stage 31 source diff SHA-256: 7ae72584fa94013b2e3db0f5bc465064a81aa77560d4978261b6a54559bf3abd
Node: v22.23.1
npm: 10.9.8
```

The hash was reproduced with:

```sh
git diff 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**' | sha256sum
```

The working-tree status before and after build commands was unchanged:

```text
 M .dd-apm-pipeline/PROGRESS.md
?? .dd-apm-evidence/genkit/29-human-approval.md
?? .dd-apm-evidence/genkit/30-review-finalize.json
?? .dd-apm-evidence/genkit/30-review-finalize.md
```

## Commands and output

### Full project type-check

```sh
npm run type:check
```

Exit code: `2`.

```text
> dd-trace@7.0.0-pre type:check
> tsc --noEmit -p tsconfig.dev.json

tsconfig.dev.json(13,21): error TS5107: Option 'alwaysStrict=false' is deprecated and will stop functioning in TypeScript 7.0. Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
tsconfig.dev.json(31,5): error TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0. Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
  Visit https://aka.ms/ts6 for migration information.
```

Classification: repository-wide pre-project-source compiler blocker, previously recorded in Stage 13. It is still
a non-zero required build check and therefore prevents Stage 31 from passing.

### Generated configuration types

```sh
npm run verify:config:types
```

Exit code: `0`.

```text
> dd-trace@7.0.0-pre verify:config:types
> node scripts/generate-config-types.js --check
```

### Generated supported integrations

```sh
npm run verify:supported-integrations
```

Exit code: `1`.

```text
> dd-trace@7.0.0-pre verify:supported-integrations
> node scripts/generate-supported-integrations.js --check

Out of date: supported_versions_output.json
Out of date: supported_versions_table.csv

Run: npm run generate:supported-integrations
```

Classification: Genkit-owned generated artifacts are missing from the frozen source state. The required repair is
to run `npm run generate:supported-integrations`, review and commit the generated changes, invalidate prior final
gate evidence, and restart at Stage 31.

### Changed JavaScript syntax

Every changed/new JavaScript production and test file was passed to `node --check` in one bounded loop (16 files,
including Genkit instrumentation/plugin/LLMObs and shared OTel bridge changes).

Exit code: `0`. Output: empty.

### Whitespace and final state

```sh
git diff --check 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**'
```

Exit code: `0`. Output: empty.

## Handoff

- Stage 31 status: **failed**.
- Stage 32 must not start.
- Repair the stale generated supported-integration artifacts outside the final gate, then restart final validation
  from Stage 31 on the new frozen source state.
- The TypeScript 6 repository-wide configuration failure remains an explicit build blocker unless the workflow
  owner defines a narrower canonical build gate or the repository configuration is fixed separately.
