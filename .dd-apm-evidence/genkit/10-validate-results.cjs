'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const evidenceRoot = __dirname
const sampleRoot = path.join(evidenceRoot, '09-sample-app')
const results = JSON.parse(fs.readFileSync(path.join(evidenceRoot, '10-fresh-sample-results.json'), 'utf8'))
const packageManifest = JSON.parse(fs.readFileSync(path.join(sampleRoot, 'package.json'), 'utf8'))
const services = JSON.parse(fs.readFileSync(path.join(sampleRoot, 'services', 'required-services.json'), 'utf8'))
const sourceFiles = ['sample-app.js', 'esm-smoke.mjs']

assert.deepStrictEqual(packageManifest.dependencies, { genkit: '1.21.0' })
assert.deepStrictEqual(services.services, [])

for (const sourceFile of sourceFiles) {
  const source = fs.readFileSync(path.join(sampleRoot, sourceFile), 'utf8')
  assert.ok(source.startsWith("'use strict'\n\n/* eslint-disable no-console */\n"), `${sourceFile} required header`)
  assert.doesNotMatch(source, /(?:require\(['"]dd-trace['"]\)|from ['"]dd-trace['"])/)
  assert.doesNotMatch(source, /(?:https?:\/\/|node:(?:net|http|https|dns)|require\(['"](?:net|http|https|dns)['"]\)|\bfetch\s*\()/)
  const environmentReads = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(match => match[1])
  assert.deepStrictEqual(environmentReads, sourceFile === 'sample-app.js' ? ['RESULTS_PATH'] : [])
}

assert.strictEqual(results.package, 'genkit')
assert.strictEqual(results.version, '1.21.0')
assert.strictEqual(results.moduleFormat, 'commonjs')
assert.strictEqual(results.unexpectedErrorCount, 0)
assert.strictEqual(results.operations.length, 14)

const expectedCases = [
  ['generation', 'success'],
  ['generationError', 'expected_error'],
  ['generationStream', 'success'],
  ['generationStreamError', 'expected_error'],
  ['workflow', 'success'],
  ['workflowError', 'expected_error'],
  ['flowStepError', 'expected_error'],
  ['tool', 'success'],
  ['toolError', 'expected_error'],
  ['toolInterrupt', 'success'],
  ['retrieval', 'success'],
  ['retrievalError', 'expected_error'],
  ['embedding', 'success'],
  ['embeddingError', 'expected_error'],
]

assert.deepStrictEqual(results.operations.map(({ name, status }) => [name, status]), expectedCases)

const byName = Object.fromEntries(results.operations.map(operation => [operation.name, operation]))
assert.deepStrictEqual(byName.generationStream.value.chunkOrder, ['offline ', 'stream complete'])
assert.strictEqual(byName.generationStream.value.chunkCount, 2)
assert.strictEqual(byName.generationStream.value.streamCompleted, true)
assert.strictEqual(byName.generationStream.value.finalResponseAwaited, true)
assert.strictEqual(byName.generationStream.value.finalOutput, 'Offline generation complete.')
assert.deepStrictEqual(byName.workflow.value.toolLoopEvents, [
  'model-turn-1',
  'tool-lookupWeather',
  'model-turn-2',
])
assert.strictEqual(byName.workflow.value.documentCount, 1)
assert.strictEqual(byName.workflow.value.embeddingCount, 2)
assert.strictEqual(byName.toolInterrupt.value.finishReason, 'interrupted')
assert.strictEqual(byName.retrieval.value.length, 1)
assert.match(byName.retrieval.value[0].text, /offline retrieval query/)
assert.deepStrictEqual(byName.embedding.value, { count: 2, dimensions: [3, 3] })

const expectedErrors = {
  generationError: 'intentional model runner failure',
  generationStreamError: 'intentional model runner failure',
  workflowError: 'intentional flow runner failure',
  flowStepError: 'intentional flow step failure',
  toolError: 'intentional tool runner failure',
  retrievalError: 'intentional retriever runner failure',
  embeddingError: 'intentional embedder runner failure',
}

for (const [name, message] of Object.entries(expectedErrors)) {
  assert.strictEqual(byName[name].expectedError, true)
  assert.deepStrictEqual(byName[name].error, { name: 'Error', message })
}

console.log(JSON.stringify({
  status: 'passed',
  sourceHeaders: sourceFiles,
  operationCount: results.operations.length,
  unexpectedErrorCount: results.unexpectedErrorCount,
  streaming: byName.generationStream.value,
  toolLoopOrder: byName.workflow.value.toolLoopEvents,
  interruptFinishReason: byName.toolInterrupt.value.finishReason,
  services: services.services,
}, null, 2))
