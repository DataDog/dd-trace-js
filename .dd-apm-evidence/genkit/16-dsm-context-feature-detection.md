# Stage 16: DSM and context-propagation feature detection

Both features are **not applicable** to the exact `genkit@1.21.0` integration.

## Decisions

| Feature | Applicable | Evidence-based reason |
| --- | --- | --- |
| `dsm` | No | Genkit is not a messaging or queue system and has no producer/consumer pair. The selected `@genkit-ai/core` `runInNewSpan` hook represents model, workflow, tool, retrieval, and embedding action execution. It has no topic, queue, partition, offset, consumer group, message carrier, or DSM pathway boundary. |
| `context_propagation` | No | The selected hook is an in-process orchestration boundary, not an HTTP/RPC client/server or messaging transport. Runtime context contains operation options, metadata, result/error, and async ancestry, but no carrier into which trace headers could be injected or from which they could be extracted. Provider and transport integrations own propagation at their actual network boundaries. |

Genkit does preserve **in-process async context**: its exact `runInNewSpan` implementation starts an active OTel span and runs the action callback under Genkit async context. The Datadog plugin returns the current store so nested selected spans inherit their parents. This is ordinary span parenting, not the Stage 16 distributed-carrier feature.

Repository comparisons confirm the distinction. Kafka DSM uses producer and consumer checkpoints plus pathway encoding/decoding. Kafka and gRPC distributed propagation inject into or extract from message headers/metadata. The Genkit plugin contains none of these operations because its hook exposes no transport carrier.

No dedicated DSM or context-propagation feature guide was found under `.agents` or `.codex`. Decisions therefore follow the explicit applicability rules in Stage 16 and concrete repository implementations.

## Reproduction

From `/workspace/repo`:

```sh
node -e "const x=require('./.dd-apm-evidence/genkit/12-final-analysis.json'); console.log(x.package, x.analysis.instrumentation_targets.map(t => [t.operation_type, t.span_kind]))"
sed -n '60,160p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/tracing/instrumentation.ts
sed -n '280,410p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/action.ts
rg -n "dsmEnabled|setCheckpoint|pathway|inject|extract" packages/datadog-plugin-genkit packages/datadog-instrumentations/src/genkit.js
sed -n '1,130p' packages/datadog-plugin-kafkajs/src/producer.js
sed -n '1,110p' packages/datadog-plugin-kafkajs/src/consumer.js
sed -n '1,150p' packages/datadog-plugin-grpc/src/client.js
sed -n '1,130p' packages/datadog-plugin-grpc/src/server.js
```

Production code and `.dd-apm-pipeline/PROGRESS.md` were not modified by this feature-detection worker.
