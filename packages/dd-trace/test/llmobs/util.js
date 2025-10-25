'use strict'

const { before, beforeEach, after } = require('mocha')
const util = require('node:util')

const tracerVersion = require('../../../../package.json').version

const MOCK_STRING = Symbol('string')
const MOCK_NUMBER = Symbol('number')
const MOCK_OBJECT = Symbol('object')
const MOCK_ANY = Symbol('any')

const MODEL_SPAN_KINDS = ['llm', 'embedding']

/**
 * @typedef {{
 *   spanKind: 'llm' | 'embedding' | 'agent' | 'workflow' | 'task' | 'tool' | 'retrieval',
 *   name: string,
 *   inputData: { [key: string]: any },
 *   outputData: { [key: string]: any },
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
    const unexpectedKeys = actualKeys.filter(key => !expectedKeys.includes(key))
    const missingKeys = expectedKeys.filter(key => !actualKeys.includes(key))

    if (unexpectedKeys.length > 0) {
      assert.fail(`${actualWithName} has unexpected keys: ${unexpectedKeys.join(', ')}`)
    }
    if (missingKeys.length > 0) {
      assert.fail(`${actualWithName} is missing expected keys: ${missingKeys.join(', ')}`)
    }

    for (const objKey of Object.keys(expected)) {
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
 *
 * @param {ExpectedLLMObsSpanEvent} expected
 * @param {*} actual
 */
function assertLlmObsSpanEvent (actual, expected = {}) {
  const {
    spanKind,
    name,
    inputData,
    outputData,
    metrics,
    metadata,
    modelName,
    modelProvider,
    parentId,
    error,
    span,
    sessionId,
    tags,
    traceId = MOCK_STRING // used for future custom LLMObs trace IDs
  } = expected

  // assert model name and provider configuration
  if ((modelName || modelProvider) && !MODEL_SPAN_KINDS.includes(spanKind)) {
    assert.fail('Model name and provider are only supported for llm and embedding spans')
  } else if (MODEL_SPAN_KINDS.includes(spanKind) && !(modelName || modelProvider)) {
    assert.fail('Model name and provider are required for llm and embedding spans')
  }

  if (modelName) assert.equal(actual.meta.model_name, modelName, 'Model name does not match')
  if (modelProvider) assert.equal(actual.meta.model_provider, modelProvider, 'Model provider does not match')

  // assert span kind and name
  assert.equal(actual.meta['span.kind'], spanKind, 'Span event kind does not match')
  assert.equal(actual.name, name, 'Span event name does not match')

  const inputMetaKey =
    spanKind === 'llm'
      ? 'messages'
      : spanKind === 'embedding'
        ? 'documents'
        : 'value'

  const outputMetaKey =
    spanKind === 'llm'
      ? 'messages'
      : spanKind === 'retrieval'
        ? 'documents'
        : 'value'

  // assert input and output data
  assertWithMockValues(actual.meta.input[inputMetaKey], inputData, `input.${inputMetaKey}`)
  assertWithMockValues(actual.meta.output[outputMetaKey], outputData, `output.${outputMetaKey}`)

  // assert metrics
  assertWithMockValues(actual.metrics, metrics ?? {}, 'metrics')

  // assert metadata
  assertWithMockValues(actual.meta.metadata, metadata, 'metadata')

  // assert status and error
  assert.ok(actual.status === (error ? 'error' : 'ok'), 'Status does not match')
  if (error) {
    assertWithMockValues(actual.meta['error.message'], error.message, 'error.message')
    assertWithMockValues(actual.meta['error.type'], error.type, 'error.type')
    assertWithMockValues(actual.meta['error.stack'], error.stack, 'error.stack')
  }

  // assert tags
  if (!tags.ml_app) assert.fail('`mlApp` should be specified in the span event tags for assertion')
  const baseExpectedTags = expectedLLMObsTags({ span, tags, error, errorType: error?.type, sessionId })
  assertWithMockValues(actual.tags, baseExpectedTags, 'tags')

  // assert span information
  assertWithMockValues(actual.trace_id, traceId, 'traceId')
  assert.equal(actual.span_id, fromBuffer(span.span_id))
  assert.equal(actual.parent_id, parentId ?? 'undefined')
  assert.equal(actual.start_ns, fromBuffer(span.start, true), 'Start timestamp does not match')
  assert.equal(actual.duration, fromBuffer(span.duration, true), 'Duration does not match')
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
    'language:javascript'
  ]

  if (sessionId) spanTags.push(`session_id:${sessionId}`)

  if (error) {
    spanTags.push('error:1')
    if (errorType) spanTags.push(`error_type:${errorType}`)
  } else {
    spanTags.push('error:0')
  }

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

const agent = require('../plugins/agent')
const assert = require('node:assert')
const { useEnv } = require('../../../../integration-tests/helpers')

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
