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
const MOCK_NOT_NULLISH = Symbol('not-nullish')

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
 * @param {object} actual
 * @param {ExpectedLLMObsSpanEvent} expected
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
  } else if (expected === MOCK_NOT_NULLISH) {
    assert.ok(actual != null, `${actualWithName} does not exist`)
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${actualWithName} (${util.inspect(actual)}) is not an array`)
    assert.equal(
      actual.length,
      expected.length,
      `${actualWithName} has different length than expected (${actual.length} !== ${expected.length})`
    )

    for (let i = 0; i < expected.length; i++) {
      assertWithMockValues(actual[i], expected[i], `${key}.${i}`)
    }
  } else if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object') {
      assert.fail(`${actualWithName} is not an object`)
    }

    const actualKeys = Object.keys(actual)
    const expectedKeys = Object.keys(expected)
    if (actualKeys.length !== expectedKeys.length) {
      assert.fail(
        `
        ${actualWithName} has different length than expected (${actualKeys.length} !== ${expectedKeys.length}).
        Diff: ${util.inspect(actualKeys)} !== ${util.inspect(expectedKeys)}`
      )
    }

    for (const objKey of expectedKeys) {
      assert.ok(Object.hasOwn(actual, objKey), `${actualWithName} does not have key ${objKey}`)
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
 * @param {object} actual
 * @param {ExpectedLLMObsSpanEvent} expected
 */
function assertLlmObsSpanEvent (actual, expected) {
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

  // 1. assert arbitrary objects (mock values)
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

  // 1a. sort tags since they might be unordered
  const expectedTags = expectedLLMObsTags({ span, tags, error, sessionId })
  const sortedExpectedTags = [...expectedTags.sort()]
  const sortedActualTags = [...actualTags.sort()]
  for (let i = 0; i < sortedExpectedTags.length; i++) {
    assert.equal(
      sortedActualTags[i],
      sortedExpectedTags[i],
      `tags[${i}] does not match expected (${sortedExpectedTags[i]} !== ${sortedActualTags[i]})`
    )
  }

  if (outputMessages) {
    assertWithMockValues(actualOutputMessages, outputMessages, 'outputMessages')
  } else if (outputDocuments) {
    assertWithMockValues(actualOutputDocuments, outputDocuments, 'outputDocuments')
  } else if (outputValue) {
    assertWithMockValues(actualOutputValue, outputValue, 'outputValue')
  }

  // 2. assert deepEqual on everything else
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

  if (error) spanTags.push(`error_type:${span.meta[ERROR_TYPE]}`)
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

  const resetTracesPromises = () => {
    apmTracesPromise = agent.assertSomeTraces(apmTraces => {
      return apmTraces
        .flatMap(trace => trace)
        .sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0))
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

  return async function (numLlmObsSpans = 1) {
    // get apm spans from the agent
    const apmSpans = await apmTracesPromise
    resetTracesPromises()

    // get llmobs span events requests from the agent
    // because llmobs process spans on span finish and submits periodically,
    // we need to aggregate all of the span events
    // tests should know how many spans they expect to see, otherwise tests will timeout
    const llmobsSpans = []

    while (llmobsSpans.length < numLlmObsSpans) {
      await new Promise(resolve => setImmediate(resolve))
      const llmobsSpanEventsRequests = agent.getLlmObsSpanEventsRequests(true)
      llmobsSpans.push(...getLlmObsSpansFromRequests(llmobsSpanEventsRequests))
    }

    return { apmSpans, llmobsSpans: llmobsSpans.sort((a, b) => a.start_ns - b.start_ns) }
  }
}

function getLlmObsSpansFromRequests (llmobsSpanEventsRequests) {
  return llmobsSpanEventsRequests
    .flatMap(request => request)
    .map(request => request.spans[0])
}

/**
 * Verifies prompt tracking metadata in span events.
 * Note: Prompt IDs (pmpt_*) are real reusable prompts created on "Datadog Staging" OpenAI's dashboard for testing.
 *
 * @param {object} spanEvent - The LLMObs span event to verify
 * @param {object} expectedPrompt - Expected prompt metadata (id, version, variables, chat_template)
 * @param {Array<{role: string, content: string}>} expectedInputMessages - Expected input messages
 * @param {object} options - Optional configuration
 * @param {string} options.promptTrackingSource - Expected prompt tracking source ('auto' or 'manual'),
 *   defaults to 'auto'
 * @param {boolean} options.promptMultimodal - Whether prompt contains multimodal inputs,
 *   defaults to false
 */
function assertPromptTracking (
  spanEvent,
  expectedPrompt,
  expectedInputMessages,
  { promptTrackingSource = 'auto', promptMultimodal = false } = {}
) {
  // Verify input messages are captured from instructions
  assert(spanEvent.meta.input.messages, 'Input messages should be present')
  assert(Array.isArray(spanEvent.meta.input.messages), 'Input messages should be an array')

  for (const expected of expectedInputMessages) {
    const message = spanEvent.meta.input.messages.find(m => m.role === expected.role)
    assert(message, `Should have a ${expected.role} message`)
    assert.strictEqual(message.content, expected.content)
  }

  // Verify prompt metadata
  assert(spanEvent.meta.input.prompt, 'Prompt metadata should be present')
  const prompt = spanEvent.meta.input.prompt
  assert.strictEqual(prompt.id, expectedPrompt.id)
  assert.strictEqual(prompt.version, expectedPrompt.version)
  assert.deepStrictEqual(prompt.variables, expectedPrompt.variables)
  assert.deepStrictEqual(prompt.chat_template, expectedPrompt.chat_template)

  // Verify tags
  assert(spanEvent.tags, 'Span event should include tags')
  assert(spanEvent.tags.includes(`prompt_tracking_source:${promptTrackingSource}`))
  if (promptMultimodal) {
    assert(spanEvent.tags.includes('prompt_multimodal:true'))
  }
}

module.exports = {
  assertLlmObsSpanEvent,
  assertPromptTracking,
  useLlmObs,
  MOCK_NOT_NULLISH,
  MOCK_NUMBER,
  MOCK_STRING,
  MOCK_OBJECT
}
