'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
require('./setup/core')
const constants = require('../src/constants')
const tags = require('../../../ext/tags')
const id = require('../src/id')
const { getExtraServices } = require('../src/service-naming/extra-services')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const MEASURED = tags.MEASURED
const ORIGIN_KEY = constants.ORIGIN_KEY
const HOSTNAME_KEY = constants.HOSTNAME_KEY
const SAMPLING_AGENT_DECISION = constants.SAMPLING_AGENT_DECISION
const SAMPLING_LIMIT_DECISION = constants.SAMPLING_LIMIT_DECISION
const SAMPLING_RULE_DECISION = constants.SAMPLING_RULE_DECISION
const SPAN_SAMPLING_MECHANISM = constants.SPAN_SAMPLING_MECHANISM
const SPAN_SAMPLING_RULE_RATE = constants.SPAN_SAMPLING_RULE_RATE
const SPAN_SAMPLING_MAX_PER_SECOND = constants.SPAN_SAMPLING_MAX_PER_SECOND
const SAMPLING_MECHANISM_SPAN = constants.SAMPLING_MECHANISM_SPAN
const TOP_LEVEL_KEY = constants.TOP_LEVEL_KEY
const PROCESS_ID = constants.PROCESS_ID
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE

const spanId = id('0234567812345678')
const spanId2 = id('0254567812345678')
const spanId3 = id('0264567812345678')

describe('spanFormat', () => {
  let spanFormat
  let span
  let trace
  let spanContext
  let spanContext2
  let spanContext3
  let TraceState

  beforeEach(() => {
    TraceState = require('../src/opentracing/propagation/tracestate')
    spanContext = {
      _traceId: spanId,
      _spanId: spanId,
      _parentId: spanId,
      _tags: {},
      _metrics: {},
      _sampling: {},
      _trace: {
        started: [],
        tags: {},
      },
      _name: 'operation',
      toTraceId: sinon.stub().returns(spanId),
      toSpanId: sinon.stub().returns(spanId),
      getTag (key) { return this._tags[key] },
      getTags () { return this._tags },
      setTag (key, value) { this._tags[key] = value },
      hasTag (key) { return key in this._tags },
    }

    span = {
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test',
        serviceLower: 'test',
      }),
      setTag: sinon.stub(),
      _startTime: 1500000000000.123,
      _duration: 100,
    }

    spanContext._trace.started.push(span)

    spanContext2 = {
      ...spanContext,
      _traceId: spanId2,
      _spanId: spanId2,
      _parentId: spanId2,
      toTraceId: sinon.stub().returns(spanId2.toString(16)),
      toSpanId: sinon.stub().returns(spanId2.toString(16)),
    }
    spanContext3 = {
      ...spanContext,
      _traceId: spanId3,
      _spanId: spanId3,
      _parentId: spanId3,
      toTraceId: sinon.stub().returns(spanId3.toString(16)),
      toSpanId: sinon.stub().returns(spanId3.toString(16)),
    }

    spanFormat = require('../src/span_format')
  })

  describe('spanFormat', () => {
    it('should pass span events through to the encoder as the raw _events array', () => {
      // The formatter no longer reshapes events; each encoder derives
      // time_unix_nano from startTime via eventTimeNano. extractSpanEvents
      // must hand the raw array straight through without copying.
      span._events = [
        { name: 'Something went so wrong', startTime: 1 },
        {
          name: 'I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx',
          attributes: { emotion: 'happy', rating: 9.8, other: [1, 9.5, 1], idol: false },
          startTime: 1633023102,
        },
      ]

      trace = spanFormat(span)

      assert.strictEqual(trace.span_events, span._events)
    })

    it('should convert a span to the correct trace format', () => {
      trace = spanFormat(span)

      assert.strictEqual(trace.trace_id.toString(), span.context()._traceId.toString())
      assert.strictEqual(trace.span_id.toString(), span.context()._spanId.toString())
      assert.strictEqual(trace.parent_id.toString(), span.context()._parentId.toString())
      assertObjectContains(trace, {
        name: span.context()._name,
        resource: span.context()._name,
        error: 0,
        start: span._startTime * 1e6,
        duration: span._duration * 1e6,
      })
    })

    it('applies OTel HTTP semantics when DD_TRACE_OTEL_SEMANTICS_ENABLED is set', () => {
      span.tracer.returns({
        _service: 'test',
        serviceLower: 'test',
        _config: { DD_TRACE_OTEL_SEMANTICS_ENABLED: true },
      })
      spanContext._tags = {
        'span.kind': 'server',
        'http.method': 'GET',
        'http.url': 'http://localhost:8080/u?x=1',
        'http.status_code': 200,
      }

      trace = spanFormat(span)

      assert.strictEqual(trace.meta['http.request.method'], 'GET')
      assert.strictEqual(trace.meta['url.path'], '/u')
      assert.strictEqual(trace.meta['url.scheme'], 'http')
      assert.strictEqual(trace.meta['http.response.status_code'], '200')
      assert.ok(!('http.method' in trace.meta))
      assert.ok(!('http.url' in trace.meta))
      assert.ok(!('http.status_code' in trace.meta))
    })

    it('pins the formatted-span hidden-class shape for a representative HTTP server span', () => {
      // Regression guard for the typed-helper inlining: covers every slot
      // `formatSpan` / `extractTags` / `extractRootTags` / `extractChunkTags`
      // populate for a chunk-root HTTP server span (the Express-profile shape
      // that motivated the inlining). The pre-initialised `service`, `type`,
      // and `span_events` slots stay in `Object.keys` even when the tag never
      // fires, so the hidden class doesn't transition mid-formatting.
      spanContext._parentId = null
      spanContext._tags = {
        'service.name': 'svc',
        'span.type': 'web',
        'resource.name': 'GET /users/:id',
        'span.kind': 'server',
        'http.method': 'GET',
        'http.url': 'https://example.com/users/42',
        'http.route': '/users/:id',
        'http.useragent': 'Mozilla/5.0',
        component: 'express',
        'http.status_code': 200,
        'http.response.content_length': 4096,
      }
      spanContext._sampling.priority = 1
      spanContext._trace.tags = {
        '_dd.p.dm': '-0',
        '_dd.p.tid': '671d3c4500000000',
      }
      spanContext._trace[SAMPLING_RULE_DECISION] = 1
      span._startTime = 1_500_000_000_000.123
      span._duration = 1.234

      trace = spanFormat(span, true, false)

      assert.deepStrictEqual(trace, {
        trace_id: spanContext._traceId,
        span_id: spanContext._spanId,
        parent_id: id('0'),
        name: 'operation',
        resource: 'GET /users/:id',
        service: 'svc',
        type: 'web',
        error: 0,
        meta: {
          '_dd.p.dm': '-0',
          '_dd.p.tid': '671d3c4500000000',
          'span.kind': 'server',
          'http.method': 'GET',
          'http.url': 'https://example.com/users/42',
          'http.route': '/users/:id',
          'http.useragent': 'Mozilla/5.0',
          component: 'express',
          'http.status_code': '200',
          language: 'javascript',
        },
        meta_struct: undefined,
        metrics: {
          [SAMPLING_RULE_DECISION]: 1,
          [TOP_LEVEL_KEY]: 1,
          [MEASURED]: 1,
          'http.response.content_length': 4096,
          [PROCESS_ID]: process.pid,
          [SAMPLING_PRIORITY_KEY]: 1,
        },
        start: Math.round(1_500_000_000_000.123 * 1e6),
        duration: Math.round(1.234 * 1e6),
        span_events: undefined,
      })
    })

    it('should truncate meta and metric keys/values past the agent-side limits', () => {
      const {
        MAX_META_KEY_LENGTH,
        MAX_META_VALUE_LENGTH,
        MAX_METRIC_KEY_LENGTH,
      } = require('../src/encode/tags-processors')

      // Last-accepted lengths (exact limit) round-trip untouched.
      const acceptedMetaKey = 'a'.repeat(MAX_META_KEY_LENGTH)
      const acceptedMetaValue = 'a'.repeat(MAX_META_VALUE_LENGTH)
      const acceptedMetricKey = `${'b'.repeat(MAX_METRIC_KEY_LENGTH - 1)}!`
      span.context()._tags[acceptedMetaKey] = acceptedMetaValue
      span.context()._tags[acceptedMetricKey] = 11

      // First-rejected lengths (limit + 1) get sliced and gain a `...` suffix.
      // Cover all four typed branches in `addMixedTag`: string / number /
      // boolean / Buffer (the URL branch shares the boolean/buffer truncation
      // line).
      const overlongMetaKey = `${'c'.repeat(MAX_META_KEY_LENGTH)}X`
      const overlongMetaValue = `${'d'.repeat(MAX_META_VALUE_LENGTH)}Y`
      const overlongMetricKey = `${'e'.repeat(MAX_METRIC_KEY_LENGTH)}Z`
      const overlongBoolKey = `${'f'.repeat(MAX_METRIC_KEY_LENGTH)}Q`
      const overlongBufferKey = `${'g'.repeat(MAX_METRIC_KEY_LENGTH)}R`
      span.context()._tags[overlongMetaKey] = overlongMetaValue
      span.context()._tags[overlongMetricKey] = 42
      span.context()._tags[overlongBoolKey] = true
      span.context()._tags[overlongBufferKey] = Buffer.from('payload')

      // `service.name` is dispatched through `addStringTag` (not the
      // polymorphic helper); pin its value-truncate branch here too.
      const overlongServiceValue = `${'s'.repeat(MAX_META_VALUE_LENGTH)}!`
      span.context()._tags['service.name'] = overlongServiceValue

      trace = spanFormat(span)

      const truncatedMetaKey = `${overlongMetaKey.slice(0, MAX_META_KEY_LENGTH)}...`
      const truncatedMetaValue = `${overlongMetaValue.slice(0, MAX_META_VALUE_LENGTH)}...`
      const truncatedMetricKey = `${overlongMetricKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      const truncatedBoolKey = `${overlongBoolKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      const truncatedBufferKey = `${overlongBufferKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      const truncatedServiceValue = `${overlongServiceValue.slice(0, MAX_META_VALUE_LENGTH)}...`
      assert.strictEqual(trace.meta[acceptedMetaKey], acceptedMetaValue)
      assert.strictEqual(trace.meta[truncatedMetaKey], truncatedMetaValue)
      assert.strictEqual(trace.metrics[acceptedMetricKey], 11)
      assert.strictEqual(trace.metrics[truncatedMetricKey], 42)
      assert.strictEqual(trace.metrics[truncatedBoolKey], 1)
      assert.strictEqual(trace.metrics[truncatedBufferKey], 'payload')
      assert.strictEqual(trace.service, truncatedServiceValue)
    })

    it('truncates overlong Datadog-tag string values to the agent value limit', () => {
      const { MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')
      // `span.type`, `resource.name`, and `http.status_code` each have
      // their own inlined truncation branch in the `extractTags` switch
      // (the inlining bypasses `addMixedTag`'s polymorphic slow path).
      // Pin all three so a refactor that drops one of them surfaces here.
      const overlongType = `${'t'.repeat(MAX_META_VALUE_LENGTH)}!`
      const overlongResource = `${'r'.repeat(MAX_META_VALUE_LENGTH)}!`
      const overlongStatusCode = `${'9'.repeat(MAX_META_VALUE_LENGTH)}!`
      spanContext._tags['span.type'] = overlongType
      spanContext._tags['resource.name'] = overlongResource
      spanContext._tags['http.status_code'] = overlongStatusCode

      trace = spanFormat(span)

      assert.strictEqual(trace.type, `${overlongType.slice(0, MAX_META_VALUE_LENGTH)}...`)
      assert.strictEqual(trace.resource, `${overlongResource.slice(0, MAX_META_VALUE_LENGTH)}...`)
      assert.strictEqual(
        trace.meta['http.status_code'],
        `${overlongStatusCode.slice(0, MAX_META_VALUE_LENGTH)}...`
      )
    })

    it('truncates overlong origin and hostname meta values to the agent value limit', () => {
      const { MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')
      const overlongOrigin = `${'o'.repeat(MAX_META_VALUE_LENGTH)}!`
      const overlongHostname = `${'h'.repeat(MAX_META_VALUE_LENGTH)}!`
      spanContext._trace.origin = overlongOrigin
      spanContext._hostname = overlongHostname

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ORIGIN_KEY], `${overlongOrigin.slice(0, MAX_META_VALUE_LENGTH)}...`)
      assert.strictEqual(trace.meta[HOSTNAME_KEY], `${overlongHostname.slice(0, MAX_META_VALUE_LENGTH)}...`)
    })

    it('should truncate the serialized span_links meta value past MAX_META_VALUE_LENGTH', () => {
      const { MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')

      const ctxFor = (innerSpanId) => ({
        toTraceId: () => innerSpanId,
        toSpanId: () => innerSpanId,
        _tracestate: undefined,
        _sampling: {},
      })
      // One link with a giant value attribute pushes the JSON serialization
      // past the 25_000-char limit.
      span._links = [
        {
          context: ctxFor(spanId.toString()),
          attributes: { huge: 'h'.repeat(MAX_META_VALUE_LENGTH) },
        },
      ]

      trace = spanFormat(span)

      const serialized = trace.meta['_dd.span_links']
      assert.strictEqual(serialized.length, MAX_META_VALUE_LENGTH + 3)
      assert.match(serialized, /\.\.\.$/)
    })

    it('should always set a parent ID', () => {
      span.context()._parentId = null

      trace = spanFormat(span)

      assert.strictEqual(trace.trace_id.toString(), span.context()._traceId.toString())
      assert.strictEqual(trace.span_id.toString(), span.context()._spanId.toString())
      assert.strictEqual(trace.parent_id.toString(), '0000000000000000')
      assertObjectContains(trace, {
        name: span.context()._name,
        resource: span.context()._name,
        error: 0,
        start: span._startTime * 1e6,
        duration: span._duration * 1e6,
      })
    })

    describe('_dd.base_service', () => {
      it('should infer the tag when span service changes', () => {
        span.context()._tags['service.name'] = 'foo'

        trace = spanFormat(span)

        sinon.assert.calledWith(span.setTag, '_dd.base_service', 'test')
      })

      it('should infer the tag when no changes occur', () => {
        span.context()._tags['service.name'] = 'test'

        trace = spanFormat(span)

        sinon.assert.notCalled(span.setTag)
      })

      it('should treat a case-only service difference as no change', () => {
        span.context()._tags['service.name'] = 'TEST'

        trace = spanFormat(span)

        sinon.assert.notCalled(span.setTag)
      })

      it('should register extra service name', () => {
        span.context()._tags['service.name'] = 'foo'

        trace = spanFormat(span)

        assert.deepStrictEqual(getExtraServices(), ['foo'])
      })
    })

    it('should extract Datadog specific tags', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'
      spanContext._tags['http.status_code'] = 200

      trace = spanFormat(span)

      assertObjectContains(trace, {
        service: 'service',
        type: 'type',
        resource: 'resource',
        meta: { 'http.status_code': '200' },
      })
    })

    it('should skip non-string values for the string-typed Datadog tag slots', () => {
      // `span.type`, `resource.name`, and `http.status_code` are dispatched
      // through `addStringTag`. Non-string source values are dropped instead
      // of leaking into metrics (the prior throwaway-`{}` pattern hid the
      // same skip behind an allocated empty object).
      spanContext._tags['span.type'] = false
      spanContext._tags['resource.name'] = { foo: 'bar' }
      // `value && String(value)` short-circuits on `0`, so the addStringTag
      // call receives a non-string and skips writing.
      spanContext._tags['http.status_code'] = 0

      trace = spanFormat(span)

      assert.strictEqual(trace.type, undefined)
      // `trace.resource` is initialised by `formatSpan` from the span name
      // and must not be overwritten when the source tag is not a string.
      assert.strictEqual(trace.resource, spanContext._name)
      assert.strictEqual(trace.meta['http.status_code'], undefined)
    })

    it('should extract Datadog specific root tags', () => {
      spanContext._parentId = null
      spanContext._trace[SAMPLING_AGENT_DECISION] = 0.8
      spanContext._trace[SAMPLING_LIMIT_DECISION] = 0.2
      spanContext._trace[SAMPLING_RULE_DECISION] = 0.5

      trace = spanFormat(span)

      assertObjectContains(trace.metrics, {
        [SAMPLING_AGENT_DECISION]: 0.8,
        [SAMPLING_LIMIT_DECISION]: 0.2,
        [SAMPLING_RULE_DECISION]: 0.5,
      })
    })

    it('should not extract Datadog specific root tags from non-root spans', () => {
      spanContext._trace[SAMPLING_AGENT_DECISION] = 0.8
      spanContext._trace[SAMPLING_LIMIT_DECISION] = 0.2
      spanContext._trace[SAMPLING_RULE_DECISION] = 0.5

      trace = spanFormat(span)

      const sampledKeys = [SAMPLING_AGENT_DECISION, SAMPLING_LIMIT_DECISION, SAMPLING_RULE_DECISION]
      assert.ok(
        !sampledKeys.some(k => Object.hasOwn(trace.metrics, k)),
        `Expected none of ${inspect(sampledKeys)} in metrics, got keys: ${inspect(Object.keys(trace.metrics))}`
      )
    })

    it('should skip root tag decisions whose source value is undefined', () => {
      // The `typeof === 'number'` gate skips any decision the priority
      // sampler never set, so partial-decision spans emit only the metric
      // they actually own. `Sampler.rate()` / `RateLimiter.effectiveRate()`
      // cannot return `NaN` (the `Sampler` constructor throws via
      // `BigInt(Math.floor(NaN * MAX_TRACE_ID))` long before the field can
      // be assigned), so the `undefined` case is the only one to pin.
      spanContext._parentId = null
      spanContext._trace[SAMPLING_LIMIT_DECISION] = 0.2
      // SAMPLING_AGENT_DECISION / SAMPLING_RULE_DECISION intentionally unset.

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics[SAMPLING_LIMIT_DECISION], 0.2)
      assert.ok(!(SAMPLING_AGENT_DECISION in trace.metrics))
      assert.ok(!(SAMPLING_RULE_DECISION in trace.metrics))
    })

    it('should always add single span ingestion tags from options if present', () => {
      spanContext._spanSampling = {
        maxPerSecond: 5,
        sampleRate: 1.0,
      }
      trace = spanFormat(span)

      assertObjectContains(trace.metrics, {
        [SPAN_SAMPLING_MECHANISM]: SAMPLING_MECHANISM_SPAN,
        [SPAN_SAMPLING_MAX_PER_SECOND]: 5,
        [SPAN_SAMPLING_RULE_RATE]: 1.0,
      })
    })

    it('should not add single span ingestion tags if options not present', () => {
      trace = spanFormat(span)

      const spanSamplingKeys = [SPAN_SAMPLING_MECHANISM, SPAN_SAMPLING_MAX_PER_SECOND, SPAN_SAMPLING_RULE_RATE]
      assert.ok(
        !spanSamplingKeys.some(k => Object.hasOwn(trace.metrics, k)),
        `Expected none of ${inspect(spanSamplingKeys)} in metrics, got keys: ${inspect(Object.keys(trace.metrics))}`
      )
    })

    it('should format span links', () => {
      span._links = [
        {
          context: spanContext2,
        },
        {
          context: spanContext3,
        },
      ]

      trace = spanFormat(span)
      const spanLinks = JSON.parse(trace.meta['_dd.span_links'])

      assert.deepStrictEqual(spanLinks, [{
        trace_id: spanId2.toString(16),
        span_id: spanId2.toString(16),
      }, {
        trace_id: spanId3.toString(16),
        span_id: spanId3.toString(16),
      }])
    })

    it('creates a span link', () => {
      const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
      const traceIdHigh = '0000000000000010'
      spanContext2._tracestate = ts
      spanContext2._trace = {
        started: [],
        finished: [],
        origin: 'synthetics',
        tags: {
          '_dd.p.tid': traceIdHigh,
        },
      }

      spanContext2._sampling.priority = 0
      const link = {
        context: spanContext2,
        attributes: { foo: 'bar' },
      }
      span._links = [link]

      trace = spanFormat(span)
      const spanLinks = JSON.parse(trace.meta['_dd.span_links'])

      assert.deepStrictEqual(spanLinks, [{
        trace_id: spanId2.toString(16),
        span_id: spanId2.toString(16),
        attributes: { foo: 'bar' },
        tracestate: ts.toString(),
        flags: 0,
      }])
    })

    it('should extract trace chunk tags', () => {
      spanContext._trace.tags = {
        chunk: 'test',
        count: 1,
      }

      trace = spanFormat(span, true, 'process-tag-value')

      assertObjectContains(trace.meta, {
        chunk: 'test',
        '_dd.tags.process': 'process-tag-value',
      })

      assertObjectContains(trace.metrics, {
        count: 1,
      })
    })

    it('truncates overlong chunk tag keys and values to the agent limit', () => {
      const { MAX_META_KEY_LENGTH, MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')
      const overlongChunkKey = `${'k'.repeat(MAX_META_KEY_LENGTH)}!`
      const overlongChunkValue = `${'v'.repeat(MAX_META_VALUE_LENGTH)}!`
      // A second tag with a short key and overlong value pins the value
      // truncation branch of the inlined `extractChunkTags` for-loop. The
      // first tag pairs an overlong key with a short value (key branch);
      // `tagForFirstSpanInChunk` pairs an overlong process-tag value with
      // its own dedicated truncation branch.
      const overlongTraceTagValue = `${'b'.repeat(MAX_META_VALUE_LENGTH)}!`
      spanContext._trace.tags = {
        [overlongChunkKey]: 'short',
        '_dd.p.tid': overlongTraceTagValue,
      }

      trace = spanFormat(span, true, overlongChunkValue)

      const truncatedKey = `${overlongChunkKey.slice(0, MAX_META_KEY_LENGTH)}...`
      const truncatedValue = `${overlongChunkValue.slice(0, MAX_META_VALUE_LENGTH)}...`
      const truncatedTraceTagValue = `${overlongTraceTagValue.slice(0, MAX_META_VALUE_LENGTH)}...`
      assert.strictEqual(trace.meta[truncatedKey], 'short')
      assert.strictEqual(trace.meta['_dd.tags.process'], truncatedValue)
      assert.strictEqual(trace.meta['_dd.p.tid'], truncatedTraceTagValue)
    })

    it('should not extract trace chunk tags when not chunk root', () => {
      spanContext._trace.tags = {
        chunk: 'test',
        count: 1,
      }

      trace = spanFormat(span, false)
      assert.ok(!('chunk' in trace.meta))
      assert.ok(!('count' in trace.metrics))
    })

    it('should extract empty tags', () => {
      spanContext._trace.tags = {
        foo: '',
        count: 1,
      }

      trace = spanFormat(span, true)

      assertObjectContains(trace.meta, {
        foo: '',
      })

      assertObjectContains(trace.metrics, {
        count: 1,
      })
    })

    it('should discard user-defined tags with name HOSTNAME_KEY by default', () => {
      spanContext._tags[HOSTNAME_KEY] = 'some_hostname'

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[HOSTNAME_KEY], undefined)
    })

    it('should include the real hostname of the system if reportHostname is true', () => {
      spanContext._hostname = 'my_hostname'
      trace = spanFormat(span)

      assert.strictEqual(trace.meta[HOSTNAME_KEY], 'my_hostname')
    })

    it('should only extract tags that are not Datadog specific to meta', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'
      spanContext._tags['foo.bar'] = 'foobar'

      trace = spanFormat(span)

      assertObjectContains(trace, {
        meta: {
          'foo.bar': 'foobar',
        },
      })
      assert.ok(!Object.hasOwn(trace.meta, 'service.name'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
      assert.ok(!Object.hasOwn(trace.meta, 'span.type'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
      assert.ok(!Object.hasOwn(trace.meta, 'resource.name'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
    })

    it('omits tags whose value is undefined from meta and metrics', () => {
      // resolveServiceSource clears a speculative tag by assigning undefined
      // (rather than deleting, which would push _tags into dictionary mode);
      // a cleared key stays in Object.keys but must not be emitted.
      spanContext._tags['foo.bar'] = undefined

      trace = spanFormat(span)

      assert.ok(!Object.hasOwn(trace.meta, 'foo.bar'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
      assert.ok(!Object.hasOwn(trace.metrics, 'foo.bar'), `Available keys: ${inspect(Object.keys(trace.metrics))}`)
    })

    it('should extract numeric tags as metrics', () => {
      spanContext._tags = { metric: 50 }

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics.metric, 50)
    })

    it('should extract buffer tags as stringified metrics', () => {
      spanContext._tags.payload = Buffer.from('hello')

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics.payload, 'hello')
    })

    it('should extract URL tags as stringified metrics', () => {
      // `addMixedTag`'s default branch routes both `Buffer` and `URL` to
      // metrics as `value.toString()`. The Buffer half is covered above;
      // pin the URL half so a future tightening that drops `isUrl` from
      // the helper surfaces here.
      const url = new URL('https://example.com/foo?bar=1')
      spanContext._tags.endpoint = url

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics.endpoint, url.toString())
    })

    it('should extract boolean tags as metrics', () => {
      spanContext._tags = { yes: true, no: false }

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics.yes, 1)
      assert.strictEqual(trace.metrics.no, 0)
    })

    it('should ignore metrics with invalid type', () => {
      spanContext._metrics = { metric: 'test' }

      trace = spanFormat(span)

      assert.ok(!('metric' in trace.metrics))
    })

    it('should ignore metrics that are not a number', () => {
      // Numeric user tags with `NaN` are dropped before they reach metrics
      // via `addMixedTag`'s number branch.
      spanContext._tags.metric = Number.NaN

      trace = spanFormat(span)

      assert.ok(!('metric' in trace.metrics))
    })

    it('should extract errors', () => {
      const error = new Error('boom')

      spanContext._tags.error = error
      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_MESSAGE], error.message)
      assert.strictEqual(trace.meta[ERROR_TYPE], error.name)
      assert.strictEqual(trace.meta[ERROR_STACK], error.stack)
    })

    it('should skip error properties without a value', () => {
      const error = new Error('boom')

      error.name = null
      error.stack = null
      spanContext._tags.error = error
      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_MESSAGE], error.message)
      assert.ok(!(ERROR_TYPE in trace.meta))
      assert.ok(!(ERROR_STACK in trace.meta))
    })

    it('should fall back to error.code when error.message is empty', () => {
      const error = new Error('')
      error.code = 'E_BOOM'
      spanContext._tags.error = error

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_MESSAGE], 'E_BOOM')
    })

    it('coerces non-string error tag values to meta strings', () => {
      spanContext._tags[ERROR_TYPE] = 42
      spanContext._tags[ERROR_MESSAGE] = { code: 'E_BOOM' }
      spanContext._tags[ERROR_STACK] = true

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_TYPE], '42')
      assert.strictEqual(trace.meta[ERROR_MESSAGE], '[object Object]')
      assert.strictEqual(trace.meta[ERROR_STACK], 'true')
      assert.ok(!(ERROR_TYPE in trace.metrics))
      assert.ok(!(ERROR_MESSAGE in trace.metrics))
      assert.ok(!(ERROR_STACK in trace.metrics))
      assert.strictEqual(trace.error, 1)
    })

    it('skips null and undefined error tag values without writing meta', () => {
      spanContext._tags[ERROR_TYPE] = null
      spanContext._tags[ERROR_MESSAGE] = undefined
      spanContext._tags[ERROR_STACK] = 'real stack'

      trace = spanFormat(span)

      assert.ok(!(ERROR_TYPE in trace.meta))
      assert.ok(!(ERROR_MESSAGE in trace.meta))
      assert.strictEqual(trace.meta[ERROR_STACK], 'real stack')
      // Any of the three present (even null) still flips `error=1` unless
      // OTel's `IGNORE_OTEL_ERROR` flag suppresses it.
      assert.strictEqual(trace.error, 1)
    })

    it('truncates overlong error tag values to the agent value limit', () => {
      const { MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')
      const overlongStack = `${'s'.repeat(MAX_META_VALUE_LENGTH)}!`
      spanContext._tags[ERROR_STACK] = overlongStack

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_STACK], `${overlongStack.slice(0, MAX_META_VALUE_LENGTH)}...`)
    })

    it('coerces non-string Error subclass fields to meta strings via extractError', () => {
      class WeirdError extends Error {}
      const error = new WeirdError()
      error.name = Symbol('CustomName')
      error.message = 1234
      error.stack = ['frame-0', 'frame-1']
      spanContext._tags.error = error

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_TYPE], 'Symbol(CustomName)')
      assert.strictEqual(trace.meta[ERROR_MESSAGE], '1234')
      assert.strictEqual(trace.meta[ERROR_STACK], 'frame-0,frame-1')
      assert.ok(!(ERROR_TYPE in trace.metrics))
      assert.ok(!(ERROR_MESSAGE in trace.metrics))
      assert.ok(!(ERROR_STACK in trace.metrics))
    })

    it('truncates overlong Error.message via extractError', () => {
      const { MAX_META_VALUE_LENGTH } = require('../src/encode/tags-processors')
      const overlongMessage = `${'m'.repeat(MAX_META_VALUE_LENGTH)}!`
      const error = new Error(overlongMessage)
      spanContext._tags.error = error

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ERROR_MESSAGE], `${overlongMessage.slice(0, MAX_META_VALUE_LENGTH)}...`)
    })

    it('should extract the origin', () => {
      spanContext._trace.origin = 'synthetics'

      trace = spanFormat(span)

      assert.strictEqual(trace.meta[ORIGIN_KEY], 'synthetics')
    })

    it('should add the language tag for a basic span', () => {
      trace = spanFormat(span)

      assert.strictEqual(trace.meta.language, 'javascript')
    })

    describe('when there is an `error` tag ', () => {
      it('should set the error flag when error tag is true', () => {
        spanContext._tags.error = true

        trace = spanFormat(span)

        assert.strictEqual(trace.error, 1)
      })

      it('should not set the error flag when error is false', () => {
        spanContext._tags.error = false

        trace = spanFormat(span)

        assert.strictEqual(trace.error, 0)
      })

      it('should not extract error to meta', () => {
        spanContext._tags.error = true

        trace = spanFormat(span)

        assert.strictEqual(trace.meta.error, undefined)
      })
    })

    it('should set the error flag when there is an error-related tag without a set trace tag', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''

      trace = spanFormat(span)

      assert.strictEqual(trace.error, 1)
    })

    it('should set the error flag when there is an error-related tag with should setTrace', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''
      spanContext._tags.setTraceError = 1

      trace = spanFormat(span)

      assert.strictEqual(trace.error, 1)

      spanContext._tags[ERROR_TYPE] = 'foo'
      spanContext._tags[ERROR_MESSAGE] = 'foo'
      spanContext._tags[ERROR_STACK] = 'foo'

      assert.strictEqual(trace.error, 1)
    })

    it('should not set the error flag for internal spans with error tags', () => {
      spanContext._tags[ERROR_TYPE] = 'Error'
      spanContext._tags[ERROR_MESSAGE] = 'boom'
      spanContext._tags[ERROR_STACK] = ''
      spanContext._name = 'fs.operation'

      trace = spanFormat(span)

      assert.strictEqual(trace.error, 0)
    })

    it('should not set the error flag for internal spans with error tag', () => {
      spanContext._tags.error = new Error('boom')
      spanContext._name = 'fs.operation'

      trace = spanFormat(span)

      assert.strictEqual(trace.error, 0)
    })

    it('should sanitize the input', () => {
      spanContext._name = null
      spanContext._tags = {
        'foo.bar': null,
        'baz.qux': undefined,
      }
      span._startTime = NaN
      span._duration = NaN

      trace = spanFormat(span)

      assert.strictEqual(trace.name, 'null')
      assert.strictEqual(trace.resource, 'null')
      assert.ok(!('foo.bar' in trace.meta))
      assert.ok(!('baz.qux' in trace.meta))
      assert.strictEqual(typeof trace.start, 'number')
      assert.strictEqual(typeof trace.duration, 'number')
    })

    it('should include the sampling priority', () => {
      spanContext._sampling.priority = 0
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[SAMPLING_PRIORITY_KEY], 0)
    })

    it('should support only the first level of depth for objects', () => {
      const tag = {
        A: {
          B: {},
          num: '2',
        },
        num: '1',
      }

      spanContext._tags.nested = tag
      trace = spanFormat(span)

      assertObjectContains(trace, {
        meta: {
          'nested.num': '1',
        },
      })
      assert.ok(!Object.hasOwn(trace.meta, 'nested.A'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
      assert.ok(!Object.hasOwn(trace.meta, 'nested.A.B'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
      assert.ok(!Object.hasOwn(trace.meta, 'nested.A.num'), `Available keys: ${inspect(Object.keys(trace.meta))}`)
    })

    it('routes nested-object child values of every type through addMixedTag recursion', () => {
      const {
        MAX_META_KEY_LENGTH,
        MAX_META_VALUE_LENGTH,
        MAX_METRIC_KEY_LENGTH,
      } = require('../src/encode/tags-processors')
      // Top-level tags hit the inlined fast paths in `extractTags`. The
      // depth-1 recursion in `addMixedTag` is the only place the helper's
      // typeof / truncation branches stay reachable, so cover every shape
      // (string / number / boolean / NaN / overlong key / overlong value)
      // through a single nested-object tag.
      const overlongMetaChildKey = 'z'.repeat(MAX_META_KEY_LENGTH)
      const overlongStringValue = 'v'.repeat(MAX_META_VALUE_LENGTH + 1)
      const overlongMetricChildKey = 'm'.repeat(MAX_METRIC_KEY_LENGTH)
      const overlongBoolChildKey = 'b'.repeat(MAX_METRIC_KEY_LENGTH)
      spanContext._tags.nested = {
        str: 'one',
        long_value: overlongStringValue,
        [overlongMetaChildKey]: 'short',
        num: 2,
        [overlongMetricChildKey]: 7,
        bool: true,
        nope: false,
        [overlongBoolChildKey]: false,
        nan: Number.NaN,
      }

      trace = spanFormat(span)

      const truncatedString = `${overlongStringValue.slice(0, MAX_META_VALUE_LENGTH)}...`
      const truncatedMetaKey = `${`nested.${overlongMetaChildKey}`.slice(0, MAX_META_KEY_LENGTH)}...`
      const truncatedMetricKey = `${`nested.${overlongMetricChildKey}`.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      const truncatedBoolKey = `${`nested.${overlongBoolChildKey}`.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      assert.strictEqual(trace.meta['nested.str'], 'one')
      assert.strictEqual(trace.meta['nested.long_value'], truncatedString)
      assert.strictEqual(trace.meta[truncatedMetaKey], 'short')
      assert.strictEqual(trace.metrics['nested.num'], 2)
      assert.strictEqual(trace.metrics[truncatedMetricKey], 7)
      assert.strictEqual(trace.metrics['nested.bool'], 1)
      assert.strictEqual(trace.metrics['nested.nope'], 0)
      assert.strictEqual(trace.metrics[truncatedBoolKey], 0)
      assert.ok(!('nested.nan' in trace.metrics))
    })

    it('should accept a boolean for measured', () => {
      spanContext._tags[MEASURED] = true
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[MEASURED], 1)
    })

    it('should accept a numeric value for measured', () => {
      spanContext._tags[MEASURED] = 0
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[MEASURED], 0)
    })

    it('should accept undefined for measured', () => {
      spanContext._tags[MEASURED] = undefined
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[MEASURED], 1)
    })

    it('should not measure internal spans', () => {
      spanContext._tags['span.kind'] = 'internal'
      trace = spanFormat(span)
      assert.ok(!(MEASURED in trace.metrics))
    })

    it('should not measure unknown spans', () => {
      trace = spanFormat(span)
      assert.ok(!(MEASURED in trace.metrics))
    })

    it('should measure non-internal spans', () => {
      spanContext._tags['span.kind'] = 'server'
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[MEASURED], 1)
    })

    it('should not override explicit measure decision', () => {
      spanContext._tags[MEASURED] = 0
      spanContext._tags['span.kind'] = 'server'
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[MEASURED], 0)
    })

    it('should possess a process_id tag', () => {
      trace = spanFormat(span)
      assert.strictEqual(trace.metrics[PROCESS_ID], process.pid)
    })

    it('should not crash on prototype-free tags objects when nesting', () => {
      const tags = Object.create(null)
      tags.nested = { foo: 'bar' }
      spanContext._tags.nested = tags

      spanFormat(span)
    })

    it('should capture analytics.event', () => {
      spanContext._tags['analytics.event'] = 1

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics['_dd1.sr.eausr'], 1)
    })

    it('should map analytics.event false to a zero metric', () => {
      spanContext._tags['analytics.event'] = false

      trace = spanFormat(span)

      assert.strictEqual(trace.metrics['_dd1.sr.eausr'], 0)
    })
  })
})
