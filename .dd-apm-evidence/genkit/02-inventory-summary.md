# Stage 02: `genkit@1.21.0` exported surface inventory

Date: 2026-07-13 UTC

## Result

Static analysis completed for all 19 public subpaths in the installed `genkit@1.21.0` manifest. The TypeScript
compiler resolved each public declaration entry, followed all declaration re-exports into the installed Genkit
dependencies, and reported no diagnostics. A separate AST pass inspected the generated CommonJS entry files. As a
validation only, each CommonJS entry was loaded in an isolated child process and its enumerable runtime names were
compared with the declared value exports.

The complete structured result, including every export, callable signature, constructor signature, directly
declared class/interface member, source declaration, CJS export map, runtime name cross-check, and limitation is in
`02-export-inventory.json`. Compact one-row-per-export and one-row-per-member views are in
`02-export-inventory.tsv` and `02-export-inventory-members.tsv`.

## Validation totals

| Measure | Count |
| --- | ---: |
| Manifest public entry points analyzed | 19 |
| Export occurrences across entry points | 473 |
| Unique public export names | 268 |
| Value export occurrences | 203 |
| Type-only export occurrences | 270 |
| Callable value export occurrences | 89 |
| Exported class occurrences | 33 |
| Exported interface occurrences | 90 |
| Direct declared member occurrences | 814 |
| Direct declared method occurrences | 153 |
| Explicit generated-CJS export occurrences | 103 |
| Generated-CJS dynamic re-export occurrences | 2 |
| TypeScript diagnostics | 0 |
| Runtime entry-load failures | 0 |
| Entry points with declaration/runtime name differences | 2 |

## Entry-point counts

| Subpath | Declared | Values | Type-only | Runtime values | Callable values | Classes | Direct methods |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `.` | 138 | 52 | 86 | 51 | 20 | 14 | 75 |
| `./registry` | 4 | 1 | 3 | 1 | 0 | 1 | 19 |
| `./beta` | 138 | 52 | 86 | 51 | 20 | 14 | 48 |
| `./tracing` | 23 | 18 | 5 | 18 | 9 | 1 | 3 |
| `./logging` | 1 | 1 | 0 | 1 | 0 | 0 | 0 |
| `./schema` | 8 | 4 | 4 | 4 | 3 | 1 | 0 |
| `./formats` | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| `./retriever` | 24 | 7 | 17 | 7 | 2 | 1 | 5 |
| `./reranker` | 11 | 5 | 6 | 5 | 1 | 1 | 1 |
| `./embedder` | 9 | 2 | 7 | 2 | 1 | 0 | 0 |
| `./evaluator` | 19 | 8 | 11 | 8 | 1 | 0 | 0 |
| `./model` | 54 | 24 | 30 | 24 | 3 | 0 | 2 |
| `./model/middleware` | 5 | 4 | 1 | 4 | 4 | 0 | 0 |
| `./extract` | 2 | 2 | 0 | 2 | 2 | 0 | 0 |
| `./testing` | 1 | 1 | 0 | 1 | 1 | 0 | 0 |
| `./tool` | 8 | 5 | 3 | 5 | 5 | 0 | 0 |
| `./plugin` | 18 | 12 | 6 | 12 | 12 | 0 | 0 |
| `./beta/client` | 2 | 2 | 0 | 2 | 2 | 0 | 0 |
| `./context` | 6 | 3 | 3 | 3 | 3 | 0 | 0 |

## Operation-related surfaces discovered

The root `Genkit` class directly declares the operation surfaces required by the target contract:

- Generation: `generate` (three overloads) and `generateStream` (three overloads).
- Workflow: `defineFlow` and `run` (two overloads).
- Tools and prompts: `defineTool`, `dynamicTool`, `prompt`, and `definePrompt`.
- Retrieval/indexing: `defineRetriever`, `defineSimpleRetriever`, `retrieve`, `defineIndexer`, and `index`.
- Embeddings: `defineEmbedder`, `embed`, and `embedMany`.
- Reranking/evaluation/model registration: `defineReranker`, `rerank`, `defineEvaluator`, `evaluate`, and two
  `defineModel` overloads.

The beta class adds direct `chat` overloads and `defineResource`; inherited `Genkit` members are intentionally not
duplicated by the inventory. Additional public callable surfaces include tracing helpers (`runInNewSpan`,
`appendSpan`), tool factories, plugin model/embedder/retriever/reranker factories, and beta client `runFlow` and
`streamFlow`. Full signatures and declaration locations are retained in the raw JSON.

## Dynamic exports and discrepancies

- Root `.` and `./beta` each use generated `__reExport(..., require('./common.js'), ...)`. This is a dynamic CJS
  copy operation, so the AST report records `./common.js` as a re-export source while the declaration resolver
  supplies its complete public names. The runtime cross-check validates the resulting enumerable names.
- Root `.` and `./beta` declarations both expose `RankedDocument` as a class/value, but their runtime exports omit
  it. The generated `common.js` export map also omits it. The dedicated `./reranker` entry does export
  `RankedDocument` at runtime. This is an upstream declaration/runtime mismatch, not an extraction failure.
- `./formats` deliberately has two type-only exports and no runtime values.

## Scope and limitations

- Primary results are static: public `.d.ts` entry points are resolved with the TypeScript compiler API, including
  re-exports from installed `@genkit-ai/*` packages.
- Members are those directly declared on an exported class or interface. Inherited members are not duplicated,
  though the base class remains identifiable in its declaration source.
- Callable signatures are collected for exported runtime functions/values and callable exported types. Properties
  nested inside arbitrary exported objects are not recursively expanded.
- Generated CommonJS `__reExport` calls cannot be fully named from the call site alone; their source modules are
  recorded and the declaration graph supplies the static names.
- Runtime `Object.keys` checks validate value-name completeness only; they do not replace the static analysis and do
  not enumerate non-enumerable or lazily constructed nested values.

## Reproduction

From `/workspace/repo`:

```sh
node .dd-apm-evidence/genkit/02-inventory-exports.js \
  /tmp/dd-apm-genkit-1.21.0/node_modules/genkit \
  .dd-apm-evidence/genkit/02-export-inventory.json
```

Successful final output:

```json
{
  "entryPointCount": 19,
  "exportOccurrences": 473,
  "uniqueExportNames": 268,
  "valueExportOccurrences": 203,
  "typeOnlyExportOccurrences": 270,
  "callableValueExportOccurrences": 89,
  "classExportOccurrences": 33,
  "interfaceExportOccurrences": 90,
  "declaredMemberOccurrences": 814,
  "declaredMethodOccurrences": 153,
  "staticRuntimeExplicitExportOccurrences": 103,
  "dynamicReExportOccurrences": 2,
  "diagnosticCount": 0,
  "runtimeValidationFailures": 0,
  "runtimeDeclarationMismatchEntryPoints": 2
}
```

The analyzer rejects any installed package other than exactly `genkit@1.21.0`. Its initial development run exposed
an incorrect TypeScript API call (`type.getSignaturesOfType`); changing it to the compiler-supported
`checker.getSignaturesOfType` resolved that analyzer error before the evidence above was generated.
