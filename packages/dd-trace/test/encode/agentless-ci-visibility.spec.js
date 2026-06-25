'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const id = require('../../src/id')

const {
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('../../src/encode/tags-processors')

const { version: ddTraceVersion } = require('../../../../package.json')

describe('agentless-ci-visibility-encode', () => {
  let encoder
  let writer
  let logger
  let trace

  beforeEach(() => {
    logger = {
      debug: sinon.stub(),
    }
    const { AgentlessCiVisibilityEncoder } = proxyquire('../../src/encode/agentless-ci-visibility', {
      '../log': logger,
    })
    writer = { flush: sinon.spy() }
    encoder = new AgentlessCiVisibilityEncoder(writer, {})

    trace = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo',
      error: 0,
      meta: {
        bar: 'baz',
      },
      metrics: {
        positive: 123456712345,
        negative: -123456712345,
        float: 1.23456712345,
        negativefloat: -1.23456789,
        bigfloat: 12345678.9,
        bignegativefloat: -12345678.9,
      },
      start: 123,
      duration: 456,
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(trace)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.content.trace_id.toString(10), trace[0].trace_id.toString(10))
    assert.strictEqual(spanEvent.content.span_id.toString(10), trace[0].span_id.toString(10))
    assert.strictEqual(spanEvent.content.parent_id.toString(10), trace[0].parent_id.toString(10))
    assertObjectContains(decodedTrace, {
      version: 1,
      metadata: {
        '*': {
          language: 'javascript',
          library_version: ddTraceVersion,
        },
      },
      events: [{
        type: 'span',
        version: 1,
        content: {
          name: 'test',
          resource: 'test-r',
          service: 'test-s',
          type: 'foo',
          error: 0,
          start: 123,
          duration: 456,
        },
      }],
    })

    assert.deepStrictEqual(spanEvent.content.meta, {
      bar: 'baz',
    })
    assertObjectContains(spanEvent.content.metrics, {
      float: 1.23456712345,
      negativefloat: -1.23456789,
      bigfloat: 12345678.9,
      bignegativefloat: -12345678.9,
    })

    assert.strictEqual(spanEvent.content.metrics.positive, 123456712345)
    assert.strictEqual(spanEvent.content.metrics.negative, -123456712345)
  })

  it('should report its count', () => {
    assert.strictEqual(encoder.count(), 0)

    encoder.encode(trace)

    assert.strictEqual(encoder.count(), 1)

    encoder.encode(trace)

    assert.strictEqual(encoder.count(), 2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(trace)
    encoder.makePayload()

    assert.strictEqual(encoder.count(), 0)
  })

  it('should truncate name, service, type and resource when they are too long', () => {
    const tooLongString = new Array(500).fill('a').join('')
    const resourceTooLongString = new Array(10000).fill('a').join('')
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        bar: 'baz',
      },
      metrics: {},
      name: tooLongString,
      resource: resourceTooLongString,
      type: tooLongString,
      service: tooLongString,
      start: 123,
      duration: 456,
    }]
    encoder.encode(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.content.type.length, MAX_TYPE_LENGTH)
    assert.strictEqual(spanEvent.content.name.length, MAX_NAME_LENGTH)
    assert.strictEqual(spanEvent.content.service.length, MAX_SERVICE_LENGTH)
    // ellipsis is added
    assert.strictEqual(spanEvent.content.resource.length, MAX_RESOURCE_NAME_LENGTH + 3)
  })

  it('should fallback to a default name and service if they are not present', () => {
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        bar: 'baz',
      },
      metrics: {},
      resource: 'resource',
      start: 123,
      duration: 456,
    }]
    encoder.encode(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.content.service, DEFAULT_SERVICE_NAME)
    assert.strictEqual(spanEvent.content.name, DEFAULT_SPAN_NAME)
  })

  it('should encode all events including non-test spans alongside test sessions', () => {
    const traceWithMixedSpans = [
      {
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('1234abcd1234abcd'),
        error: 0,
        meta: {},
        metrics: {},
        start: 123,
        duration: 456,
        type: 'test_session_end',
        name: '',
        resource: '',
        service: '',
      },
      {
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('1234abcd1234abcd'),
        error: 0,
        meta: {},
        metrics: {},
        start: 123,
        duration: 456,
        type: 'http',
        name: '',
        resource: '',
        service: '',
      },
    ]

    encoder.encode(traceWithMixedSpans)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })
    assert.strictEqual(decodedTrace.events.length, 2)
    assert.strictEqual(decodedTrace.events[0].type, 'test_session_end')
    assert.deepStrictEqual(decodedTrace.events[0].content.type, 'test_session_end')
    assert.strictEqual(decodedTrace.events[1].type, 'span')
  })

  it('does not crash if test_session_id is in meta but not test_module_id', () => {
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        test_session_id: '1234abcd1234abcd',
      },
      metrics: {},
      start: 123,
      duration: 456,
      type: 'foo',
      name: '',
      resource: '',
      service: '',
    }]
    encoder.encode(traceToTruncate)
    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.type, 'span')
    assert.strictEqual(spanEvent.version, 1)
  })

  describe('addMetadataTags', () => {
    afterEach(() => {
      encoder.metadataTags = {}
      encoder.wildcardMetadataTags = {}
    })

    it('should add simple metadata tags', () => {
      const tags = {
        test: { tag: 'value1' },
        test_session_end: { tag: 'value2' },
      }
      encoder.addMetadataTags(tags)
      assert.deepStrictEqual(encoder.metadataTags, tags)
    })

    it('should merge dictionaries if there are values already', () => {
      encoder.metadataTags = {
        test: { tag: 'value1' },
      }
      const tags = {
        test: { other: 'value2' },
        test_session_end: { tag: 'value3' },
      }
      encoder.addMetadataTags(tags)
      assert.deepStrictEqual(encoder.metadataTags, {
        test: { tag: 'value1', other: 'value2' },
        test_session_end: { tag: 'value3' },
      })
    })

    it('should handle empty tags', () => {
      encoder.metadataTags = { test: { tag: 'value1' } }
      encoder.addMetadataTags({})
      assert.deepStrictEqual(encoder.metadataTags, { test: { tag: 'value1' } })
    })

    // The CI Visibility flow calls `addMetadataTags` from two channels —
    // `ci:<framework>:session:start` adds `test_session.name`, and the async
    // `ci:<framework>:library-configuration` callback adds capability tags
    // once the backend responds. If an integration finishes a span between
    // those two calls (e.g. a `dns.promises.lookup` from vite startup), the
    // encoder previously flushed the payload prefix on the first `encode()`
    // and the later capability tags never reached the wire.
    it('encodes metadata at flush time, not at first encode', () => {
      encoder.addMetadataTags({ test: { 'test_session.name': 'my-session' } })
      encoder.encode(trace)
      encoder.addMetadataTags({
        test: { '_dd.library_capabilities.auto_test_retries': '1' },
        test_session_end: { 'test_session.name': 'my-session' },
      })

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })

      assert.deepStrictEqual(decoded.metadata.test, {
        'test_session.name': 'my-session',
        '_dd.library_capabilities.auto_test_retries': '1',
      })
      assert.deepStrictEqual(decoded.metadata.test_session_end, {
        'test_session.name': 'my-session',
      })
      assert.strictEqual(decoded.events.length, 1)
    })

    it('encodes metadata added across multiple flushes', () => {
      encoder.encode(trace)
      encoder.addMetadataTags({ test: { 'first.flush.tag': '1' } })
      const firstBuffer = encoder.makePayload()
      const firstDecoded = msgpack.decode(firstBuffer, { useBigInt64: true })
      assert.deepStrictEqual(firstDecoded.metadata.test, { 'first.flush.tag': '1' })

      encoder.encode(trace)
      encoder.addMetadataTags({ test: { 'second.flush.tag': '2' } })
      const secondBuffer = encoder.makePayload()
      const secondDecoded = msgpack.decode(secondBuffer, { useBigInt64: true })

      assert.deepStrictEqual(secondDecoded.metadata.test, {
        'first.flush.tag': '1',
        'second.flush.tag': '2',
      })
    })

    it('stores wildcard tags in wildcardMetadataTags and leaves metadataTags untouched', () => {
      encoder.addMetadataTags({
        '*': { 'test.command': 'mocha', 'test_session.name': 'my-session' },
        test: { 'test_session.name': 'my-session' },
      })

      assert.deepStrictEqual(encoder.wildcardMetadataTags, {
        'test.command': 'mocha',
        'test_session.name': 'my-session',
      })
      assert.deepStrictEqual(encoder.metadataTags, {
        test: { 'test_session.name': 'my-session' },
      })
    })

    it('merges successive wildcard tags without clearing previously set ones', () => {
      encoder.addMetadataTags({ '*': { 'test.command': 'mocha' } })
      encoder.addMetadataTags({ '*': { 'test_session.name': 'my-session' } })

      assert.deepStrictEqual(encoder.wildcardMetadataTags, {
        'test.command': 'mocha',
        'test_session.name': 'my-session',
      })
    })

    it('encodes wildcard tags into metadata["*"] in the payload', () => {
      encoder.addMetadataTags({
        '*': { 'test.command': 'mocha', 'test_session.name': 'my-session' },
        test: { '_dd.library_capabilities.auto_test_retries': '1' },
      })
      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })

      assert.strictEqual(decoded.metadata['*']['test.command'], 'mocha')
      assert.strictEqual(decoded.metadata['*']['test_session.name'], 'my-session')
      assert.deepStrictEqual(decoded.metadata.test, {
        '_dd.library_capabilities.auto_test_retries': '1',
      })
    })

    it('stores metadata tags for the test levels target', () => {
      encoder.addMetadataTags({
        test_levels: { 'test.command': 'mocha' },
        'test*': { tag: 'value' },
        invalid: { tag: 'value' },
      })

      assert.deepStrictEqual(encoder.metadataTags, {
        test_levels: { 'test.command': 'mocha' },
      })
    })

    it('encodes test levels target tags into the payload', () => {
      encoder.addMetadataTags({
        test_levels: { 'test.command': 'mocha', 'test_session.name': 'my-session' },
      })
      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })

      assert.deepStrictEqual(decoded.metadata.test_levels, {
        'test.command': 'mocha',
        'test_session.name': 'my-session',
      })
    })

    it('removes matching test levels metadata tags from test level events', () => {
      encoder.addMetadataTags({
        test_levels: {
          'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
          'ci.provider.name': 'github',
        },
      })
      trace[0].type = 'test'
      trace[0].meta = {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
        'test.name': 'does not move',
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const testEvent = decoded.events[0]

      assert.deepStrictEqual(decoded.metadata.test_levels, {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      })
      assert.deepStrictEqual(testEvent.content.meta, {
        'test.name': 'does not move',
      })
    })

    it('keeps git and ci tags event local when test levels metadata is not set', () => {
      trace[0].type = 'test'
      trace[0].meta = {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const testEvent = decoded.events[0]

      assert.strictEqual(decoded.metadata.test_levels, undefined)
      assert.deepStrictEqual(testEvent.content.meta, {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      })
    })

    it('keeps event git and ci tags when they differ from test levels metadata', () => {
      encoder.addMetadataTags({
        test_levels: {
          'git.branch': 'main',
          'ci.job.name': 'unit-tests',
        },
      })
      trace[0].type = 'test'
      trace[0].meta = {
        'git.branch': 'feature',
        'ci.job.name': 'unit-tests',
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const testEvent = decoded.events[0]

      assert.deepStrictEqual(decoded.metadata.test_levels, {
        'git.branch': 'main',
        'ci.job.name': 'unit-tests',
      })
      assert.deepStrictEqual(testEvent.content.meta, {
        'git.branch': 'feature',
      })
    })

    it('keeps custom git and ci tags event local', () => {
      encoder.addMetadataTags({
        test_levels: {
          'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
          'ci.provider.name': 'github',
        },
      })
      trace[0].type = 'test'
      trace[0].meta = {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
        'git.custom': 'one-off-git-tag',
        'ci.custom': 'one-off-ci-tag',
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const testEvent = decoded.events[0]

      assert.deepStrictEqual(decoded.metadata.test_levels, {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      })
      assert.deepStrictEqual(testEvent.content.meta, {
        'git.custom': 'one-off-git-tag',
        'ci.custom': 'one-off-ci-tag',
      })
    })

    it('does not remove test levels metadata tags from non-test-level spans', () => {
      encoder.addMetadataTags({
        test_levels: {
          'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
          'ci.provider.name': 'github',
        },
      })
      trace[0].type = 'worker'
      trace[0].meta = {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const spanEvent = decoded.events[0]

      assert.deepStrictEqual(decoded.metadata.test_levels, {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      })
      assert.deepStrictEqual(spanEvent.content.meta, {
        'git.repository_url': 'https://github.com/DataDog/dd-trace-js.git',
        'ci.provider.name': 'github',
      })
    })

    it('truncates test levels metadata values like test optimization span meta', () => {
      const overlong = 'a'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION + 1)
      const expected = `${'a'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)}...`
      encoder.addMetadataTags({
        test_levels: {
          'git.commit.message': overlong,
        },
      })
      trace[0].type = 'test'
      trace[0].meta = {
        'git.commit.message': overlong,
      }

      encoder.encode(trace)

      const buffer = encoder.makePayload()
      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const testEvent = decoded.events[0]

      assert.strictEqual(decoded.metadata.test_levels['git.commit.message'], expected)
      assert.deepStrictEqual(testEvent.content.meta, {})
    })
  })
})
