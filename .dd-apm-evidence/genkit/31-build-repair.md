# Stage 31 generated-artifact repair

Date: 2026-07-14 UTC

## Result

The Stage 31 supported-integration artifact blocker is repaired. The canonical generator completed successfully,
and `npm run verify:supported-integrations` now exits zero. This repair changed exactly the two generated files
owned by that command:

- `supported_versions_output.json`
- `supported_versions_table.csv`

No production code, test logic, TypeScript configuration, or pipeline progress was modified. This repair does not
advance Stage 31 or address the separately recorded repository-wide TypeScript 6 configuration blocker.

## Genkit output

Both artifacts now contain exactly one Genkit row:

```json
{
  "dependency": "@genkit-ai/core",
  "integration": "genkit",
  "minimum_tracer_supported": "1.21.0",
  "max_tracer_supported": "1.21.0",
  "auto-instrumented": "True"
}
```

The JSON contains one row whose dependency or integration identifies Genkit; no duplicate or top-level `genkit`
dependency row was generated.

## Canonical catch-up separated from Genkit

The generator is not a Genkit-only formatter. Before this repair, the persisted artifacts were also stale relative
to the repository's already-pinned integration-version manifest and current Node engine range. The complete
canonical row comparison against `HEAD` is:

```text
rows before: 113
rows after:  114
added:       2
removed:     1
updated:     25
```

The additions are the required `@genkit-ai/core`/`genkit` row and a pre-existing `mercurius`/`graphql` catch-up.
The removal is the pre-existing `@vitest/runner`/`vitest` catch-up. The 25 updated rows reflect already-pinned
package maxima or the current Node engine minimum. They were emitted by the canonical generator and were not
hand-edited or attributed to Genkit. Filtering these non-Genkit differences makes the canonical verifier fail, so
the complete generated output is preserved.

## Commands

Run from `/workspace/repo`:

```sh
npm run generate:supported-integrations
npm run verify:supported-integrations
git diff --check HEAD -- supported_versions_output.json supported_versions_table.csv
git diff --name-only HEAD -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**'
```

Results:

```text
generate:supported-integrations: exit 0
verify:supported-integrations:   exit 0
generated-file diff check:      exit 0
repository files changed by this repair:
  supported_versions_output.json
  supported_versions_table.csv
```

## Hashes

```text
before e07769220ad374010c1d3ec4ae7845939fb59ecb05b1dd2c99f15a4d1f4126f8  supported_versions_output.json
after  891ccbd8e77911d7b18dc630e7df8608e472ccb0cc244e28139488545b530399  supported_versions_output.json

before f604394e688971b4e6510db9218ae59805ed7a9d4c1c8f924f54711f23838cc8  supported_versions_table.csv
after  c0e0f9cb52d620ec8c87db83ea5485b00b9f5bee0ae05950d801902ffdfb92f9  supported_versions_table.csv
```

The source state was `2858540854daf3a9de106a259fd99ccd7c3b8a70` before regeneration. Stage 31 must restart
from the build gate after this generated change is incorporated into the frozen source state.
