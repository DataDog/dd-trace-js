# Stage 10 independent sample validation

All application runs used the existing Stage 09 source without modification. Context capture, APM capture, LLMObs
capture, and the final observability gate were deliberately not evaluated here.

## Frozen lock and versions

Command (cwd `09-sample-app`):

```sh
env -i PATH="$PATH" HOME="$HOME" yarn install --offline --frozen-lockfile --ignore-scripts
npm list genkit @genkit-ai/core @genkit-ai/ai --depth=1
```

Exit: 0. Relevant output:

```text
yarn install v1.22.22
[1/4] Resolving packages...
[2/4] Fetching packages...
[3/4] Linking dependencies...
[4/4] Building fresh packages...
warning Ignored scripts due to flag.
Done in 2.65s.
dd-apm-genkit-1.21.0-sample@1.0.0 /workspace/repo/.dd-apm-evidence/genkit/09-sample-app
└─┬ genkit@1.21.0
  ├── @genkit-ai/ai@1.21.0
  └── @genkit-ai/core@1.21.0
```

Direct reads of the installed package manifests independently returned `genkit=1.21.0`,
`@genkit-ai/core=1.21.0`, and `@genkit-ai/ai=1.21.0`.

## Source, syntax, and lint

Both sources start with `'use strict'`, followed by the required `no-console` ESLint header. Static checks found no
`dd-trace` import, network API import/call/URL, or credential environment read. The only environment input is the
non-secret `RESULTS_PATH` output selector in the CommonJS app.

```sh
node --check sample-app.js
node --check esm-smoke.mjs
```

Both exited 0 with no output.

The original README-documented lint command, run from `09-sample-app`, exited 2:

```text
ESLint: 9.39.3
Error: ENOENT: no such file or directory, open './vendor/package.json'
```

The README was corrected to document the repository-root form below. The exact corrected command was rerun from
`/workspace/repo` and exited 0 with no output:

```sh
npm exec -- eslint --no-ignore --rule strict:off --report-unused-disable-directives-severity off \
  .dd-apm-evidence/genkit/09-sample-app/sample-app.js \
  .dd-apm-evidence/genkit/09-sample-app/esm-smoke.mjs
```

The earlier exit 2 is retained above as the discovery history; it is no longer a documentation discrepancy.

## Fresh CommonJS full run

Command (cwd `09-sample-app`):

```sh
env -i PATH="$PATH" HOME="$HOME" \
  RESULTS_PATH=/workspace/repo/.dd-apm-evidence/genkit/10-fresh-sample-results.json \
  NODE_OPTIONS=--require=/workspace/repo/.dd-apm-evidence/genkit/10-network-guard.cjs \
  node sample-app.js
```

Exit: 0 in 1.56 seconds. The clean environment supplied no credentials or telemetry exporters. Final output:

```text
teardown: wrote /workspace/repo/.dd-apm-evidence/genkit/10-fresh-sample-results.json
stage-10-network-attempts=0
```

The fresh result contains exactly 14 operations, zero unexpected errors, two ordered stream chunks followed by an
awaited final response, the ordered three-event model/tool/model loop, an interrupted tool response, successful
retrieval and two-document embeddings, and all seven expected rejection outcomes. Full structured operation output
is in `10-fresh-sample-results.json`.

## Fresh public ESM smoke

Command (cwd `09-sample-app`):

```sh
env -i PATH="$PATH" HOME="$HOME" \
  NODE_OPTIONS=--require=/workspace/repo/.dd-apm-evidence/genkit/10-network-guard.cjs \
  node esm-smoke.mjs
```

Exit: 0 in 1.42 seconds. Output:

```text
{"moduleFormat":"esm","output":"ESM generation complete."}
stage-10-network-attempts=0
```

## Structured assertion

```sh
node .dd-apm-evidence/genkit/10-validate-results.cjs
```

Exit: 0. It asserted exact case names/statuses, counts, stream completion/order, final response, tool loop, interrupt,
retrieval, embeddings, every expected error message, headers, prohibited imports/APIs, environment reads, and empty
service requirements.

No Docker/Compose/CI service file exists in the sample, and `09-sample-app/services/required-services.json` declares
an empty service list. Therefore `10-service-ci-requirements.json` emits empty GitHub Actions and GitLab CI service
configurations.
