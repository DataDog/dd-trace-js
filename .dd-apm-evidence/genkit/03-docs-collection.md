# Stage 03: documentation collection for `genkit@1.21.0`

Date: 2026-07-13 UTC

## Result

Documentation was collected from the exact installed `genkit@1.21.0` tarball, supplemented by version-specific npm
registry metadata. Current `genkit.dev` pages were not substituted for the installed documentation because their
content is not version-pinned. An official GitHub source tag could not be resolved from this environment; the exact
failures are recorded below.

## Authoritative installed artifacts

All copied files below match their installed source byte-for-byte:

| Evidence file | Installed source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `03-installed-README.md` | `genkit/README.md` | 4,521 | `759d657374daa338017c448732f9faa91977498b55c6783b03f16aebb9881385` |
| `03-guide-setup.md` | `genkit/.guides/setup.md` | 2,531 | `e0983446e078de70bf9350db8de30179eea1dd1cdcba5a295907efce240b2dce` |
| `03-guide-usage.md` | `genkit/.guides/usage.md` | 1,968 | `6466d6d68b6918c6bc2818d30954feaa7434b6084261cbce8942814f6e50618b` |
| `03-guide-style.md` | `genkit/.guides/style.md` | 83 | `a71d695e9b7d80f30b88167257b92ee1667bad193e95029e8d0ac916a6e558d3` |
| `03-guide-config.json` | `genkit/.guides/config.json` | 1,275 | `bc30e282e04c2757e4f93ff2f5501450cbc7f987b6bb6a35b1c470fe595f678d` |

The package contains no package-level `CHANGELOG` and no generated API documentation directory. Its `LICENSE` is
Apache-2.0 with SHA-256 `a3758291981a2ebedd70869225890e831d2edeef56c734a79bf02f2e5918394e`.
Dependency documentation under nested `node_modules` was excluded.

The tarball does include 23 TypeScript source files. `03-extract-source-docs.js` reproducibly extracts their JSDoc
with source paths, line numbers, tags, and source hashes into `03-source-jsdoc.json`: all 23 source files contain at
least one documentation block, for 101 blocks total.

## Package and registry provenance

Installed package metadata is preserved in `03-package-metadata.json`. It identifies:

- `genkit@1.21.0`, description `Genkit AI framework`, Apache-2.0.
- Repository `https://github.com/firebase/genkit.git`, directory `js/genkit`.
- Homepage `https://genkit.dev`.
- Installed manifest SHA-256 `d87afcdbd764e5bee2c73e77b016a907d240ec270ba3ad95cf7baa7aef83af3a`.

The bounded npm query succeeded and is preserved in `03-npm-registry-metadata.json`:

- Published at `2025-10-06T22:58:10.442Z`.
- Tarball `https://registry.npmjs.org/genkit/-/genkit-1.21.0.tgz`.
- SHA-1 `931ef9a3f66e09836393f60b142bb9215966756f`.
- Integrity
  `sha512-catTEjxhHZaicvxwak8jFL0K0H0ndN/qE9s+N7CIbsQeJczvRDleoyFa2mtaBOCaoZt7Xj8zJlYXOmt8tRyqJQ==`.
- No `deprecated` field was returned.

`npm view genkit@1.21.0 readme` returned 10,231 bytes with SHA-256
`ae8a4015d8857431ae593d452982298dd2bcf4ae545dcb7bc6b75338ced4ad91`, which does not match the exact tarball
README (4,521 bytes, hash above), even after trimming trailing whitespace. The installed tarball copy is therefore
the authoritative README for this analysis; the divergent registry README was not used for API conclusions.

## Applicable documentation findings

The exact README and source JSDoc document the relevant public concepts without relying on current website content:

- `genkit(options)` creates a Genkit registry and registers plugins/configuration.
- `generate` handles simple prompts, multipart prompts, conversation history, structured output, and automatic tool
  resolution when tools are provided.
- `generateStream` immediately returns `{ stream, response }`; callers iterate `stream` and await `response` for the
  completed generation.
- `defineFlow` creates a typed, observable workflow. The README demonstrates a flow containing generation and
  chunk forwarding.
- `run` is explicitly documented as a separately traced step within a flow.
- Tool, retriever, embedder, reranker, evaluator, indexer, prompt, and model definition/execution APIs are documented
  in the bundled `src/genkit.ts` JSDoc and enumerated in `03-source-jsdoc.json`.
- `GenkitBeta` documentation explicitly warns that beta APIs are unstable and may break without honoring semver.
- The bundled guide config names generation, flows, tool calling/interrupts, and context as relevant documentation
  topics, but those `genkit.dev` URLs are unpinned references and were not fetched as `1.21.0` evidence.

## Documentation caveats

- The bundled usage guide says “Genkit v1.19” even though it is physically shipped in the verified `1.21.0`
  tarball. Its broad 1.x clarifications are useful, but exact signatures must defer to the `1.21.0` source and type
  inventory.
- The README installation text names `@genkit-ai/googleai`, while its code imports `@genkit-ai/google-genai`.
- The README client example imports `runFlow` but calls `streamFlow`. Later sample work should follow the verified
  `1.21.0` exports rather than copying that typo.

## Remote source lookup failures

The package manifest provides no `gitHead`, so a commit-pinned upstream documentation URL could not be derived from
installed metadata.

Bounded Git tag lookup:

```text
$ timeout 15s git ls-remote --tags https://github.com/firebase/genkit.git '*1.21.0*'
remote: Request not allowed by allowlist
fatal: unable to access 'https://code-gen-sandbox.datadog.com/github.com/firebase/genkit.git/':
The requested URL returned error: 403
```

The internet search tool was also attempted for an official `firebase/genkit` `1.21.0` tag/release and failed before
returning search results:

```text
Fatal error: http 404 Not Found: Unknown compliance rule for api: /v1/alpha/search for provider: openai
```

No current/latest GitHub or website content was used as a fallback.

## Reproduction commands

Run from `/workspace/repo`:

```sh
find /tmp/dd-apm-genkit-1.21.0/node_modules/genkit -maxdepth 3 -type f \
  \( -iname 'README*' -o -iname 'CHANGELOG*' -o -path '*/.guides/*' -o -iname 'LICENSE*' \) \
  -printf '%P\t%s bytes\n' | sort

sha256sum /tmp/dd-apm-genkit-1.21.0/node_modules/genkit/{README.md,LICENSE,package.json} \
  /tmp/dd-apm-genkit-1.21.0/node_modules/genkit/.guides/{config.json,setup.md,style.md,usage.md}

npm view genkit@1.21.0 name version description dist.tarball dist.shasum dist.integrity \
  repository homepage license deprecated --json
npm view genkit@1.21.0 'time[1.21.0]' --json

node .dd-apm-evidence/genkit/03-extract-source-docs.js \
  /tmp/dd-apm-genkit-1.21.0/node_modules/genkit \
  .dd-apm-evidence/genkit/03-source-jsdoc.json

cmp /tmp/dd-apm-genkit-1.21.0/node_modules/genkit/README.md \
  .dd-apm-evidence/genkit/03-installed-README.md
cmp /tmp/dd-apm-genkit-1.21.0/node_modules/genkit/.guides/usage.md \
  .dd-apm-evidence/genkit/03-guide-usage.md
```

Successful JSDoc extraction output:

```json
{
  "sourceFileCount": 23,
  "sourceFilesWithDocumentation": 23,
  "documentationBlockCount": 101
}
```
