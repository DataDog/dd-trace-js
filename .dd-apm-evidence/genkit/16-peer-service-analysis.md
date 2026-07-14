# Stage 16 feature detection: `peer_service`

Date: 2026-07-14 UTC

## Decision

`peer_service` is **not applicable** at the selected Genkit action boundary.

The Stage 16 generic rule describes peer service as applicable to outbound clients and producers. The Stage 12
analysis calls model, retriever, and embedder spans client-like, but their shared hook is a provider-neutral action
executor rather than a network client. Span kind alone does not establish a remote peer.

No dedicated peer-service feature guide exists in this repository. The decision therefore uses the Stage 16 rule,
the repository's actual outbound peer-service implementation, exact `@genkit-ai/core@1.21.0` source, the Stage 12
analysis, current Genkit APM code, and captured runtime evidence.

The schema-conforming decision is in `16-peer-service-decision.json`.

## Evidence

### The upstream hook executes an arbitrary action callback

In exact `@genkit-ai/core@1.21.0`, `action()` converts the configured action name to a logical identifier and calls
`runInNewSpan` with only:

- `metadata.name`;
- action labels including `genkit:metadata:subtype`;
- the callback that ultimately invokes the user/provider-supplied `fn`.

The action implementation then awaits that callback through `runWithContext`. It does not resolve or expose a
hostname, port, URL, connection, socket, or transport. Relevant source is
`@genkit-ai/core/src/action.ts:287-380`, especially the hook options at lines 321-331 and callback invocation at
lines 347-369.

`runInNewSpan` itself creates an OpenTelemetry span, applies labels, manages Genkit metadata/context, invokes the
provided callback, and records completion/error state. It introduces no outbound request or peer field
(`@genkit-ai/core/src/tracing/instrumentation.ts:79-145`).

This permits all action subtypes to be implemented locally. It also means a slash-delimited action name such as
`local/offline-model` is a registry identifier, not proof of a DNS name, service, or transport endpoint.

### Stage 12/runtime context contains no peer identity

`12-final-analysis.json` maps safe APM fields for generation, retrieval, and embedding from the same hook:
component, logical action name, operation type, and resource. Its observed model action is
`local/offline-model`, and it explicitly declines to infer provider/model identity from that name.

The Stage 11 exact-version captures reinforce this boundary:

- before execution, metadata contains only `name`;
- after execution, selected captures contain `name`, path, subtype metadata, input, output/state, and failure data;
- none of the model, retriever, or embedder captures contains a hostname, port, URL, connection, or transport peer.

### Real model, retrieval, and embedding operations can be local

The exact `genkit@1.21.0` sample registers local callbacks with `defineModel`, `defineRetriever`, and
`defineEmbedder`. Stage 10 runs them in a clean environment with a network guard and reports
`stage-10-network-attempts=0`. This is a constructive counterexample to the claim that every selected client-like
Genkit action makes an outbound call.

Therefore no truthful peer value exists for these spans in the general case. The logical action name must not be
used as `peer.service`: doing so would label `local/offline-model`, `localRetriever`, and `localEmbedder` as remote
services even though they are in-process callbacks.

### Current dd-trace behavior requires an actual precursor

The current Genkit plugin extends `TracingPlugin`, records only safe action tags, and does not add `out.host`,
`net.peer.name`, `network.destination.*`, or `peer.service`
(`packages/datadog-plugin-genkit/src/index.js:8-65`).

Repository peer-service computation lives in `OutboundPlugin`. It derives `peer.service` from an explicit
integration precursor or common network precursor (`net.peer.name` or `out.host`) and applies remapping only after a
real precursor exists (`packages/dd-trace/src/plugins/outbound.js:16-94`). The Genkit hook has none of those fields.

When a Genkit action delegates to an HTTP/provider SDK, that lower-level integration sees the real endpoint and
owns peer-service attribution. Adding peer service to the outer provider-neutral action would either invent a peer
or duplicate/misattribute the transport span.

## Feature result by selected client-like operation

| Operation | Remote call guaranteed? | Peer present at hook? | `peer_service` |
| --- | --- | --- | --- |
| model/generation | No; registered model callback may be local | No | Not applicable |
| retrieval | No; registered retriever callback may be local | No | Not applicable |
| embedding | No; registered embedder callback may be local | No | Not applicable |

Workflow and tool spans are already internal and are not candidates.

## Implementation consequence

Do not add a Genkit peer-service precursor, `out.host`, `network.destination.*`, or a value derived from action name.
Keep peer attribution on an underlying provider/transport span that observes a real remote endpoint. If a future
Genkit version adds a stable endpoint field to this exact action context, feature applicability can be reconsidered
with version-specific runtime evidence.

## Reproduction commands

Run from `/workspace/repo`:

```sh
find . -type f \( -iname '*peer*service*' -o -path '*features*peer*' \) -print | sort
node -e "const x=require('./.dd-apm-evidence/genkit/12-final-analysis.json'); console.log(x.package, x.analysis.instrumentation_targets.map(t => [t.operation_type, t.span_kind]))"
sed -n '285,385p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/action.ts
sed -n '79,145p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/tracing/instrumentation.ts
sed -n '1,90p' packages/datadog-plugin-genkit/src/index.js
sed -n '1,110p' packages/dd-trace/src/plugins/outbound.js
rg -n "defineModel|defineRetriever|defineEmbedder" .dd-apm-evidence/genkit/09-sample-app/sample-app.js
rg -n "stage-10-network-attempts=0|no_network" \
  .dd-apm-evidence/genkit/10-command-output.md \
  .dd-apm-evidence/genkit/10-validation.json
node -e "const x=require('./.dd-apm-evidence/genkit/16-peer-service-decision.json'); if (x.feature_id !== 'peer_service' || x.applicable !== false) process.exit(1); console.log(JSON.stringify(x))"
```

## Provenance

```text
47efc1c78308051c2362dc069d65cee46361f68994894b593bfe77581bb5c256  12-final-analysis.json
1ad647c3bc431c528546e5b4221f350e53d5640536c19483506d5e70fe9bb321  packages/datadog-plugin-genkit/src/index.js
da48ae99fe97a8d195865c5e396d1bcbb2930b4c4bd232d416d7768d314f3644  @genkit-ai/core/src/action.ts
6d686f67c677c92e25c9e0da935028e172eb1fdc1c578d564c4c4332163d0986  @genkit-ai/core/src/tracing/instrumentation.ts
```

Production code and `.dd-apm-pipeline/PROGRESS.md` were not modified by this feature detector.
