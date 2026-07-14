'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const snapshot = JSON.parse(fs.readFileSync('.dd-apm-evidence/genkit/11-context-snapshot.json'))
const mappings = JSON.parse(fs.readFileSync('.dd-apm-evidence/genkit/11-context-mappings.json'))
const sample = JSON.parse(fs.readFileSync('.dd-apm-evidence/genkit/11-sample-results.json'))

assert.strictEqual(snapshot.target, '@genkit-ai/core@1.21.0 runInNewSpan')
assert.strictEqual(snapshot.selectedCaptureCount, 21)
assert.deepStrictEqual(snapshot.operationCounts, {
  generation: 7,
  workflow: 4,
  retrieval: 3,
  embedding: 3,
  tool: 4,
})
assert.strictEqual(mappings.mappings.length, 5)
assert.strictEqual(sample.unexpectedErrorCount, 0)

for (const operation of ['generation', 'workflow', 'tool', 'retrieval', 'embedding']) {
  const records = snapshot.records.filter(record => record.operation === operation)
  assert.ok(records.some(record => record.completion === 'success'), `${operation} success missing`)
  assert.ok(records.some(record => record.completion === 'error'), `${operation} error missing`)
  assert.ok(records.every(record => record.argumentCount === 2 && record.optionsArgumentIndex === 0))
  assert.ok(records.every(record => record.nativeSpan?.traceId && record.nativeSpan?.spanId))
  assert.ok(mappings.mappings.some(mapping => mapping.operation === operation))
}

assert.ok(snapshot.records.some(record => record.labelsBefore['genkit:type'] === 'flowStep'))
const interrupt = snapshot.records.find(record => record.metadataAfter.name === 'approvalRequired')
assert.strictEqual(interrupt.completion, 'error')
assert.strictEqual(interrupt.error.name, 'ToolInterruptError')

const mainTrace = snapshot.records.filter(record => record.nativeSpan.traceId === snapshot.records.find(
  record => record.metadataAfter.name === 'offlineWorkflow'
).nativeSpan.traceId)
assert.deepStrictEqual(mainTrace.map(record => record.captureId), [9, 10, 11, 12, 14, 15, 17])
assert.ok(mainTrace.slice(1).every(record => record.selectedParentCaptureId === 9 || record.selectedParentCaptureId === 10))

const serialized = JSON.stringify(snapshot)
assert.ok(serialized.includes('omittedNumericVector'))
assert.ok(serialized.includes('[redacted]'))
assert.ok(!serialized.includes('do-not-capture'))

let omittedVectorCount = 0
function assertVectorsOmitted (value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (key === 'embedding' && item && typeof item === 'object') {
      assert.strictEqual(item.omittedNumericVector, true)
      assert.strictEqual(typeof item.dimensions, 'number')
      omittedVectorCount++
    }
    assertVectorsOmitted(item)
  }
}
assertVectorsOmitted(snapshot)
assert.ok(omittedVectorCount > 0)

const generation = snapshot.records.find(record => record.operation === 'generation' && record.completion === 'success')
assert.deepStrictEqual(generation.result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })

console.log(JSON.stringify({
  selectedCaptureCount: snapshot.selectedCaptureCount,
  operationCounts: snapshot.operationCounts,
  mappingCount: mappings.mappings.length,
  successAndErrorCoverage: true,
  flowStepCaptured: true,
  nestingValidated: true,
  interruptSemanticsCaptured: true,
  vectorsAndSecretsSanitized: true,
}))
