'use strict'

const chai = require('chai')

const tracerVersion = require('../../../../../package.json').version

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
  const spanName = name || span.name

  const spanEvent = {
    trace_id: MOCK_STRING,
    span_id: fromBuffer(span.span_id),
    parent_id: parentId || 'undefined',
    name: spanName,
    tags: expectedLLMObsTags({ span, tags, error, errorType, sessionId }),
    start_ns: fromBuffer(span.start, true),
    duration: fromBuffer(span.duration, true),
    status: error ? 'error' : 'ok',
    meta: { 'span.kind': spanKind },
    metrics: {}
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

  const spanTags = [
    `version:${span.meta.version}`,
    `env:${span.meta.env}`,
    `service:${span.meta.service}`,
    'source:integration',
    `ml_app:${tags.ml_app}`,
    `dd-trace.version:${tracerVersion}`
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
  const { buffer, offset } = spanProperty
  const strVal = buffer.readBigInt64BE(offset).toString()
  return isNumber ? Number(strVal) : strVal
}

module.exports = {
  expectedLLMObsLLMSpanEvent,
  deepEqualWithMockValues,
  MOCK_ANY,
  MOCK_NUMBER,
  MOCK_STRING
}
