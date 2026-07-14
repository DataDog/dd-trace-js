'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const directory = __dirname
const sourceHash = '2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422'

function readJson (name) {
  return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
}

function flattenApmSpans (requests) {
  return requests.flatMap(request => request.flatMap(trace => trace))
}

function flattenLlmObsSpans (requests) {
  return requests.flatMap(request => request.flatMap(item => item.spans))
}

function llmKind (event) {
  return event.meta?.['span.kind']
}

function isRootEvent (event) {
  return event.parent_id === undefined || event.parent_id === 'undefined'
}

function findEvent (events, predicate, description) {
  const event = events.find(predicate)
  assert.ok(event, `missing ${description}`)
  return event
}

const summary = readJson('34-capture-summary.json')
const sample = readJson('34-sample-results.json')
const apmRequests = readJson('34-apm-traces.json')
const llmobsRequests = readJson('34-llmobs-requests.json')
const apmSpans = flattenApmSpans(apmRequests)
const events = flattenLlmObsSpans(llmobsRequests)

assert.strictEqual(summary.sourceDiffSha256, sourceHash)
assert.strictEqual(summary.version, '1.21.0')
assert.strictEqual(summary.otelEnabled, true)
assert.strictEqual(summary.unexpectedErrorCount, 0)
assert.strictEqual(sample.version, '1.21.0')
assert.strictEqual(sample.operations.length, 14)
assert.strictEqual(sample.unexpectedErrorCount, 0)
assert.deepStrictEqual(
  sample.operations.map(operation => operation.name),
  [
    'generation',
    'generationError',
    'generationStream',
    'generationStreamError',
    'workflow',
    'workflowError',
    'flowStepError',
    'tool',
    'toolError',
    'toolInterrupt',
    'retrieval',
    'retrievalError',
    'embedding',
    'embeddingError',
  ]
)
assert.strictEqual(sample.operations.filter(operation => operation.status === 'success').length, 7)
assert.strictEqual(sample.operations.filter(operation => operation.status === 'expected_error').length, 7)

assert.strictEqual(apmSpans.length, 21)
assert.strictEqual(events.length, 21)
assert.strictEqual(new Set(apmSpans.map(span => String(span.span_id))).size, apmSpans.length)
assert.strictEqual(new Set(events.map(event => String(event.span_id))).size, events.length)

const apmById = new Map(apmSpans.map(span => [String(span.span_id), span]))
for (const event of events) {
  const span = apmById.get(String(event.span_id))
  assert.ok(span, `LLMObs event ${event.name} has no matching APM span`)
  assert.strictEqual(event.name, span.resource)
}

const expectedKindCounts = {
  embedding: 3,
  llm: 7,
  retrieval: 3,
  tool: 4,
  workflow: 4,
}
const kindCounts = {}
for (const event of events) {
  const kind = llmKind(event)
  kindCounts[kind] = (kindCounts[kind] || 0) + 1
}
assert.deepStrictEqual(kindCounts, expectedKindCounts)

assert.strictEqual(apmSpans.filter(span => span.error === 1).length, 8)
assert.strictEqual(events.filter(event => event.status === 'error').length, 8)
for (const event of events.filter(event => event.status === 'error')) {
  assert.ok(event.meta['error.type'])
  assert.ok(event.meta['error.stack'])
}

const modelEvents = events.filter(event => llmKind(event) === 'llm')
for (const event of modelEvents) {
  assert.strictEqual(event.meta.model_name, 'local/offline-model')
  assert.strictEqual(event.meta.model_provider, 'custom')
}
const modelEventsWithMetrics = modelEvents.filter(event => Object.keys(event.metrics).length > 0)
assert.strictEqual(modelEventsWithMetrics.length, 5)
for (const event of modelEventsWithMetrics) {
  assert.strictEqual(typeof event.metrics.input_tokens, 'number')
  assert.strictEqual(typeof event.metrics.output_tokens, 'number')
  assert.strictEqual(typeof event.metrics.total_tokens, 'number')
}

const streamOperation = sample.operations.find(operation => operation.name === 'generationStream')
assert.deepStrictEqual(streamOperation.value.chunkOrder, ['offline ', 'stream complete'])
assert.strictEqual(streamOperation.value.streamCompleted, true)
assert.strictEqual(streamOperation.value.finalResponseAwaited, true)
assert.strictEqual(streamOperation.value.finalOutput, 'Offline generation complete.')
const streamEvent = findEvent(
  events,
  event => event.meta?.input?.messages?.[0]?.content === 'Stream offline.',
  'stream LLMObs event'
)
assert.strictEqual(streamEvent.meta.output.messages[0].content, 'Offline generation complete.')
assert.deepStrictEqual(streamEvent.metrics, { input_tokens: 11, output_tokens: 7, total_tokens: 18 })

const flow = findEvent(events, event => event.name === 'offlineWorkflow', 'workflow event')
const step = findEvent(events, event => event.name === 'offlineFlowStep', 'flow-step event')
assert.strictEqual(String(step.parent_id), String(flow.span_id))
for (const name of ['localRetriever', 'localEmbedder', 'lookupWeather']) {
  const child = findEvent(
    events,
    event => event.name === name && String(event.parent_id) === String(step.span_id),
    `${name} workflow child`
  )
  assert.strictEqual(String(child.parent_id), String(step.span_id))
}
assert.strictEqual(
  events.filter(event => event.name === 'local/offline-model' && String(event.parent_id) === String(step.span_id)).length,
  2
)
const flowSpan = apmById.get(String(flow.span_id))
const stepSpan = apmById.get(String(step.span_id))
assert.strictEqual(String(stepSpan.parent_id), String(flowSpan.span_id))

const retrieval = findEvent(
  events,
  event => event.name === 'localRetriever' && isRootEvent(event),
  'standalone retrieval event'
)
assert.strictEqual(retrieval.meta.input.value, 'offline retrieval query')
assert.deepStrictEqual(retrieval.meta.output.documents, [{
  text: 'Retrieved context for: offline retrieval query',
  name: 'offline-document',
  id: 'doc-1',
  score: 0.91,
}])

const embedding = findEvent(
  events,
  event => event.name === 'localEmbedder' && isRootEvent(event),
  'standalone embedding event'
)
assert.deepStrictEqual(embedding.meta.input.documents, [
  { text: 'first input document' },
  { text: 'second input document' },
])
assert.strictEqual(embedding.meta.output.value, '[2 embedding(s) returned with size 3]')
assert.strictEqual(embedding.meta.model_name, 'localEmbedder')
assert.strictEqual(embedding.meta.model_provider, 'custom')

const tool = findEvent(
  events,
  event => event.name === 'lookupWeather' && isRootEvent(event),
  'standalone tool event'
)
assert.strictEqual(tool.meta.input.value, '{"city":"Berlin"}')
assert.strictEqual(tool.meta.output.value, '{"city":"Berlin","forecast":"sunny","temperatureCelsius":21}')

const serializedApm = JSON.stringify(apmRequests)
const serializedLlmObs = JSON.stringify(llmobsRequests)
assert.doesNotMatch(serializedApm, /genkit:input|genkit:output|genkit\.internal/)
assert.doesNotMatch(serializedLlmObs, /do-not-capture|excludedSecret|"embedding":\s*\[|\[0\.1,0\.2,0\.3\]/)
assert.deepStrictEqual(
  [...new Set(apmSpans.map(span => span.name))].sort(),
  ['genkit.request', 'genkit.tool', 'genkit.workflow']
)

const validation = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  sourceDiffSha256: sourceHash,
  passed: true,
  package: 'genkit@1.21.0',
  otelEnabled: true,
  sample: {
    operationCount: sample.operations.length,
    successfulOperations: 7,
    expectedErrorOperations: 7,
    unexpectedErrors: 0,
  },
  apm: {
    requestCount: apmRequests.length,
    spanCount: apmSpans.length,
    errorSpanCount: apmSpans.filter(span => span.error === 1).length,
    operationNames: [...new Set(apmSpans.map(span => span.name))].sort(),
  },
  llmobs: {
    requestCount: llmobsRequests.length,
    spanCount: events.length,
    errorSpanCount: events.filter(event => event.status === 'error').length,
    kindCounts,
    modelEventCount: modelEvents.length,
    modelEventsWithTokenMetrics: modelEventsWithMetrics.length,
  },
  invariants: {
    everyLlmObsEventMatchesExactlyOneApmSpanId: true,
    workflowParentChildRelationshipsMatch: true,
    streamingChunksAndFinalResponseComplete: true,
    errorsRetainTypeAndStack: true,
    nativeGenkitDuplicateSpansAbsent: true,
    rawNativeGenkitInputOutputTagsAbsent: true,
    embeddingVectorsAndExcludedSecretsAbsent: true,
  },
}

fs.writeFileSync(path.join(directory, '34-observability-validation.json'), `${JSON.stringify(validation, null, 2)}\n`)
fs.writeFileSync(path.join(directory, '34-llmobs-span-index.json'), `${JSON.stringify(events.map(event => ({
  traceId: event.trace_id,
  spanId: String(event.span_id),
  parentId: event.parent_id,
  name: event.name,
  kind: llmKind(event),
  status: event.status,
  modelName: event.meta.model_name,
  modelProvider: event.meta.model_provider,
  input: event.meta.input,
  output: event.meta.output,
  metadata: event.meta.metadata,
  metrics: event.metrics,
  error: event.status === 'error'
    ? {
        type: event.meta['error.type'],
        message: event.meta['error.message'],
      }
    : undefined,
})), null, 2)}\n`)
console.log(JSON.stringify(validation, null, 2))
