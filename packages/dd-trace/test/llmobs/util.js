'use strict'

const { before, beforeEach, after } = require('mocha')
const util = require('node:util')
const agent = require('../plugins/agent')
const assert = require('node:assert')
const { useEnv } = require('../../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../src/constants')

const tracerVersion = require('../../../../package.json').version

const MOCK_STRING = Symbol('string')
const MOCK_NUMBER = Symbol('number')
const MOCK_OBJECT = Symbol('object')
const MOCK_ANY = Symbol('any')

/**
 * @typedef {{
 *   spanKind: 'llm' | 'embedding' | 'agent' | 'workflow' | 'task' | 'tool' | 'retrieval',
 *   name: string,
 *   inputMessages: { [key: string]: any },
 *   outputMessages: { [key: string]: any },
 *   inputDocuments: { [key: string]: any },
 *   outputDocuments: { [key: string]: any },
 *   inputValue: { [key: string]: any },
 *   outputValue: { [key: string]: any },
 *   metrics: { [key: string]: number },
 *   metadata: { [key: string]: any },
 *   modelName?: string,
 *   modelProvider?: string,
 *   parentId?: string,
 *   error?: { message: string, type: string, stack: string },
 *   span: unknown,
 *   sessionId?: string,
 *   tags: { [key: string]: any },
 *   traceId?: string,
 * }} ExpectedLLMObsSpanEvent
 */

/**
 *
 * @param {ExpectedLLMObsSpanEvent} expected
 * @param {*} actual
 * @param {string} key name to associate with the assertion
 */
function assertWithMockValues (actual, expected, key) {
  const actualWithName = key ? `Actual (${key})` : 'Actual'

  if (expected === MOCK_STRING) {
    assert.equal(typeof actual, 'string', `${actualWithName} (${util.inspect(actual)}) is not a string`)
  } else if (expected === MOCK_NUMBER) {
    assert.equal(typeof actual, 'number', `${actualWithName} (${util.inspect(actual)}) is not a number`)
  } else if (expected === MOCK_OBJECT) {
    assert.equal(typeof actual, 'object', `${actualWithName} (${util.inspect(actual)}) is not an object`)
  } else if (expected === MOCK_ANY) {
    assert.ok(actual != null, `${actualWithName} does not exist`)
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${actualWithName} (${util.inspect(actual)}) is not an array`)
    assert.equal(
      actual.length,
      expected.length,
      `${actualWithName} has different length than expected (${actual.length} !== ${expected.length})`
    )

    const sortedExpected = [...expected.sort()]
    const sortedActual = [...actual.sort()]

    for (let i = 0; i < sortedExpected.length; i++) {
      assertWithMockValues(sortedActual[i], sortedExpected[i], `${key}.${i}`)
    }
  } else if (typeof expected === 'object') {
    if (typeof actual !== 'object') {
      assert.fail(`${actualWithName} is not an object`)
    }

    const actualKeys = Object.keys(actual)
    const expectedKeys = Object.keys(expected)
    if (actualKeys.length !== expectedKeys.length) {
      assert.fail(
        `${actualWithName} has different length than expected (${actualKeys.length} !== ${expectedKeys.length})`
      )
    }

    for (const objKey of expectedKeys) {
      assertWithMockValues(actual[objKey], expected[objKey], `${key}.${objKey}`)
    }
  } else {
    assert.equal(
      actual,
      expected,
      `${actualWithName} does not match expected (${util.inspect(expected)} !== ${util.inspect(actual)})`
    )
  }
}

/**
 * Asserts that the actual LLMObs span event matches the span event created from the expected fields.
 *
 * Dynamic fields, like metrics, metadata, tags, traceId, and output can be asserted with mock values.
 * All other fields are asserted in a larger diff assertion.
 * @param {ExpectedLLMObsSpanEvent} expected
 * @param {*} actual
 */
function assertLlmObsSpanEvent (actual, expected = {}) {
  const {
    spanKind,
    name,
    modelName,
    modelProvider,
    parentId,
    error,
    span,
    sessionId,
    tags,
    traceId = MOCK_STRING, // used for future custom LLMObs trace IDs,
    metrics,
    metadata,
    inputMessages,
    inputValue,
    inputDocuments,
    outputMessages,
    outputValue,
    outputDocuments,
  } = expected

  if (inputMessages && inputDocuments && inputValue) {
    const correctInputType = spanKind === 'llm' ? 'messages' : spanKind === 'embedding' ? 'documents' : 'value'

    const errorMessage =
    'There should only be one of inputMessages, inputDocuments, or inputValue. ' +
    `With a span kind of ${spanKind}, the correct input type is ${correctInputType}.`

    assert.fail(errorMessage)
  } else if (inputMessages) {
    assert.equal(spanKind, 'llm', 'Span kind should be llm when inputMessages is provided')
  } else if (inputDocuments) {
    assert.equal(spanKind, 'embedding', 'Span kind should be embedding when inputDocuments is provided')
  } else if (inputValue) {
    assert.notEqual(spanKind, 'llm', 'Span kind should not be llm when inputValue is provided')
    assert.notEqual(spanKind, 'embedding', 'Span kind should not be embedding when inputValue is provided')
  } else {
    assert.equal(actual.meta.input.messages, undefined, 'input.messages should be undefined when no input is provided')
    assert.equal(
      actual.meta.input.documents,
      undefined,
      'input.documents should be undefined when no input is provided'
    )
    assert.equal(actual.meta.input.value, undefined, 'input.value should be undefined when no input is provided')
  }

  if (outputMessages && outputDocuments && outputValue) {
    const correctOutputType = spanKind === 'llm' ? 'messages' : spanKind === 'retrieval' ? 'documents' : 'value'

    const errorMessage =
    'There should only be one of outputMessages, outputDocuments, or outputValue. ' +
    `With a span kind of ${spanKind}, the correct output type is ${correctOutputType}.`

    assert.fail(errorMessage)
  } else if (outputMessages) {
    assert.equal(spanKind, 'llm', 'Span kind should be llm when outputMessages is provided')
  } else if (outputDocuments) {
    assert.equal(spanKind, 'retrieval', 'Span kind should be retrieval when outputDocuments is provided')
  } else if (outputValue) {
    assert.notEqual(spanKind, 'llm', 'Span kind should not be llm when outputValue is provided')
    assert.notEqual(spanKind, 'retrieval', 'Span kind should not be retrieval when outputValue is provided')
  } else {
    assert.equal(
      actual.meta.output.messages, undefined,
      'output.messages should be undefined when no output is provided'
    )
    assert.equal(
      actual.meta.output.documents, undefined,
      'output.documents should be undefined when no output is provided'
    )
    assert.equal(
      actual.meta.output.value, undefined,
      'output.value should be undefined when no output is provided'
    )
  }

  // assert arbitrary objects (mock values)
  const actualMetrics = actual.metrics
  const actualMetadata = actual.meta.metadata
  const actualOutputMessages = actual.meta.output.messages
  const actualOutputValue = actual.meta.output.value
  const actualOutputDocuments = actual.meta.output.documents
  const actualTraceId = actual.trace_id
  const actualTags = actual.tags

  delete actual.metrics
  delete actual.meta.metadata
  delete actual.meta.output
  delete actual.trace_id
  delete actual.tags
  delete actual._dd // we do not care about asserting on the private dd fields

  assertWithMockValues(actualTraceId, traceId, 'traceId')
  assertWithMockValues(actualMetrics, metrics ?? {}, 'metrics')
  assertWithMockValues(actualMetadata, metadata, 'metadata')
  assertWithMockValues(actualTags, expectedLLMObsTags({ span, tags, error, errorType: error?.type, sessionId }), 'tags')
  if (outputMessages) {
    assertWithMockValues(actualOutputMessages, outputMessages, 'outputMessages')
  } else if (outputDocuments) {
    assertWithMockValues(actualOutputDocuments, outputDocuments, 'outputDocuments')
  } else if (outputValue) {
    assertWithMockValues(actualOutputValue, outputValue, 'outputValue')
  }

  // assert deepEqual on everything else
  const expectedMeta = { 'span.kind': spanKind }

  if (modelName) expectedMeta.model_name = modelName
  if (modelProvider) expectedMeta.model_provider = modelProvider

  if (error) {
    expectedMeta[ERROR_MESSAGE] = span.meta[ERROR_MESSAGE]
    expectedMeta[ERROR_TYPE] = span.meta[ERROR_TYPE]
    expectedMeta[ERROR_STACK] = span.meta[ERROR_STACK]
  }

  if (inputMessages) {
    expectedMeta.input = { messages: inputMessages }
  } else if (inputDocuments) {
    expectedMeta.input = { documents: inputDocuments }
  } else if (inputValue) {
    expectedMeta.input = { value: inputValue }
  }

  const expectedSpanEvent = {
    span_id: fromBuffer(span.span_id),
    parent_id: parentId ? fromBuffer(parentId) : 'undefined',
    name,
    start_ns: fromBuffer(span.start, true),
    duration: fromBuffer(span.duration, true),
    status: error ? 'error' : 'ok',
    meta: expectedMeta
  }

  assert.deepStrictEqual(actual, expectedSpanEvent)
}

function expectedLLMObsTags ({
  span,
  error,
  errorType,
  tags,
  sessionId
}) {
  const version = span.meta?.version ?? ''
  const env = span.meta?.env ?? ''
  const service = span.meta?.service ?? ''

  const spanTags = [
    `version:${version}`,
    `env:${env}`,
    `service:${service}`,
    'source:integration',
    `ml_app:${tags.ml_app}`,
    `ddtrace.version:${tracerVersion}`,
    `error:${error ? 1 : 0}`,
    'language:javascript'
  ]

  if (errorType) spanTags.push(`error_type:${errorType}`)
  if (sessionId) spanTags.push(`session_id:${sessionId}`)

  for (const [key, value] of Object.entries(tags)) {
    if (!['version', 'env', 'service', 'ml_app'].includes(key)) {
      spanTags.push(`${key}:${value}`)
    }
  }

  return spanTags
}

function fromBuffer (spanProperty, isNumber = false) {
  const strVal = spanProperty.toString(10)
  return isNumber ? Number(strVal) : strVal
}

/**
 * @param {Object} options
 * @param {string} options.plugin
 * @param {Object} options.tracerConfigOptions
 * @param {Object} options.closeOptions
 * @returns {function(): Promise<{ apmSpans: Array, llmobsSpans: Array }>}
 */
function useLlmObs ({
  plugin,
  tracerConfigOptions = {},
  closeOptions = {}
} = {}) {
  /** @type {Promise<Array<Array<Object>>>} */
  let apmTracesPromise

  /** @type {Promise<Array<Array<Object>>>} */
  let llmobsTracesPromise

  const resetTracesPromises = () => {
    apmTracesPromise = agent.assertSomeTraces(apmTraces => {
      return apmTraces
        .flatMap(trace => trace)
        .sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0))
    })

    llmobsTracesPromise = agent.useLlmobsTraces(llmobsTraces => {
      return llmobsTraces
        .flatMap(trace => trace)
        .map(trace => trace.spans[0])
        .sort((a, b) => a.start_ns - b.start_ns)
    })
  }

  useEnv({
    _DD_LLMOBS_FLUSH_INTERVAL: 0
  })

  before(() => {
    return agent.load(plugin, {}, {
      llmobs: {
        mlApp: 'test',
        agentlessEnabled: false
      },
      ...tracerConfigOptions
    })
  })

  beforeEach(resetTracesPromises)

  after(() => {
    return agent.close({ ritmReset: false, ...closeOptions })
  })

  return async function () {
    const [apmSpans, llmobsSpans] = await Promise.all([apmTracesPromise, llmobsTracesPromise])
    resetTracesPromises()

    return { apmSpans, llmobsSpans }
  }
}

module.exports = {
  assertLlmObsSpanEvent,
  useLlmObs,
  MOCK_ANY,
  MOCK_NUMBER,
  MOCK_STRING,
  MOCK_OBJECT
}
