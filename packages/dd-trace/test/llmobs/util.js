'use strict'

const chai = require('chai')

const tracerVersion = require('../../../../package.json').version

const MOCK_STRING = Symbol('string')
const MOCK_NUMBER = Symbol('number')
const MOCK_ANY = Symbol('any')

function deepEqualWithMockValues (expected) {
  const actual = this._obj

  for (const key in actual) {
    if (expected[key] === MOCK_STRING) {
      new chai.Assertion(typeof actual[key], `key ${key}`).to.equal('string')
    } else if (expected[key] === MOCK_NUMBER) {
      new chai.Assertion(typeof actual[key], `key ${key}`).to.equal('number')
    } else if (expected[key] === MOCK_ANY) {
      new chai.Assertion(actual[key], `key ${key}`).to.exist
    } else if (Array.isArray(expected[key])) {
      const sortedExpected = [...expected[key].sort()]
      const sortedActual = [...actual[key].sort()]
      new chai.Assertion(sortedActual, `key: ${key}`).to.deep.equal(sortedExpected)
    } else if (typeof expected[key] === 'object') {
      new chai.Assertion(actual[key], `key: ${key}`).to.deepEqualWithMockValues(expected[key])
    } else {
      new chai.Assertion(actual[key], `key: ${key}`).to.equal(expected[key])
    }
  }
}

function expectedLLMObsLLMSpanEvent (options) {
  const spanEvent = expectedLLMObsBaseEvent(options)

  const meta = { input: {}, output: {} }
  const {
    spanKind,
    modelName,
    modelProvider,
    inputMessages,
    inputDocuments,
    outputMessages,
    outputValue,
    metadata,
    tokenMetrics
  } = options

  if (spanKind === 'llm') {
    if (inputMessages) meta.input.messages = inputMessages
    if (outputMessages) meta.output.messages = outputMessages
  } else if (spanKind === 'embedding') {
    if (inputDocuments) meta.input.documents = inputDocuments
    if (outputValue) meta.output.value = outputValue
  }

  if (!spanEvent.meta.input) delete spanEvent.meta.input
  if (!spanEvent.meta.output) delete spanEvent.meta.output

  if (modelName) meta.model_name = modelName
  if (modelProvider) meta.model_provider = modelProvider
  if (metadata) meta.metadata = metadata

  Object.assign(spanEvent.meta, meta)

  if (tokenMetrics) spanEvent.metrics = tokenMetrics

  return spanEvent
}

function expectedLLMObsNonLLMSpanEvent (options) {
  const spanEvent = expectedLLMObsBaseEvent(options)
  const {
    spanKind,
    inputValue,
    outputValue,
    outputDocuments,
    metadata,
    tokenMetrics
  } = options

  const meta = { input: {}, output: {} }
  if (spanKind === 'retrieval') {
    if (inputValue) meta.input.value = inputValue
    if (outputDocuments) meta.output.documents = outputDocuments
    if (outputValue) meta.output.value = outputValue
  }
  if (inputValue) meta.input.value = inputValue
  if (metadata) meta.metadata = metadata
  if (outputValue) meta.output.value = outputValue

  if (!spanEvent.meta.input) delete spanEvent.meta.input
  if (!spanEvent.meta.output) delete spanEvent.meta.output

  Object.assign(spanEvent.meta, meta)

  if (tokenMetrics) spanEvent.metrics = tokenMetrics

  return spanEvent
}

function expectedLLMObsBaseEvent ({
  span,
  parentId,
  name,
  spanKind,
  tags,
  sessionId,
  error,
  errorType,
  errorMessage,
  errorStack
} = {}) {
  // the `span` could be a raw DatadogSpan or formatted span
  const spanName = name || span.name || span._name
  const spanId = span.span_id ? fromBuffer(span.span_id) : span.context().toSpanId()
  const startNs = span.start ? fromBuffer(span.start, true) : Math.round(span._startTime * 1e6)
  const duration = span.duration ? fromBuffer(span.duration, true) : Math.round(span._duration * 1e6)

  const spanEvent = {
    trace_id: MOCK_STRING,
    span_id: spanId,
    parent_id: typeof parentId === 'bigint' ? fromBuffer(parentId) : (parentId || 'undefined'),
    name: spanName,
    tags: expectedLLMObsTags({ span, tags, error, errorType, sessionId }),
    start_ns: startNs,
    duration,
    status: error ? 'error' : 'ok',
    meta: { 'span.kind': spanKind },
    metrics: {},
    _dd: {
      trace_id: MOCK_STRING,
      span_id: spanId
    }
  }

  if (sessionId) spanEvent.session_id = sessionId

  if (error) {
    spanEvent.meta['error.type'] = errorType
    spanEvent.meta['error.message'] = errorMessage
    spanEvent.meta['error.stack'] = errorStack
  }

  return spanEvent
}

function expectedLLMObsTags ({
  span,
  error,
  errorType,
  tags,
  sessionId
}) {
  tags = tags || {}

  const version = span.meta?.version || span._parentTracer?._version
  const env = span.meta?.env || span._parentTracer?._env
  const service = span.meta?.service || span._parentTracer?._service

  const spanTags = [
    `version:${version ?? ''}`,
    `env:${env ?? ''}`,
    `service:${service ?? ''}`,
    'source:integration',
    `ml_app:${tags.ml_app}`,
    `ddtrace.version:${tracerVersion}`
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

module.exports = {
  expectedLLMObsLLMSpanEvent,
  expectedLLMObsNonLLMSpanEvent,
  deepEqualWithMockValues,
  MOCK_ANY,
  MOCK_NUMBER,
  MOCK_STRING
}
