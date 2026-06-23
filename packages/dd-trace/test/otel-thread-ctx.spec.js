'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./setup/core')

const TRACE_ID_HEX = '0102030405060708090a0b0c0d0e0f10'
const SPAN_ID_HEX = '1112131415161718'
const TRACE_ID_BYTES = Uint8Array.from(Buffer.from(TRACE_ID_HEX, 'hex'))
const SPAN_ID_BYTES = Uint8Array.from(Buffer.from(SPAN_ID_HEX, 'hex'))

function makeSpan ({ traceId = TRACE_ID_HEX, spanId = SPAN_ID_HEX, parentId, tags = {} } = {}) {
  return {
    context () {
      return {
        _spanId: spanId,
        _parentId: parentId,
        _trace: { started: [] },
        toTraceId: () => traceId.padStart(32, '0'),
        toSpanId: () => spanId.padStart(16, '0'),
        getTags: () => tags,
      }
    },
  }
}

describe('otel-thread-ctx', () => {
  let platformDescriptor
  let pprofStub
  let enterCh, spanFinishCh, tagsUpdateCh
  let webTagsResolvedCh
  let webTagsCacheStub
  let cachedWebTags
  let storageChannelsStub
  let storageStub
  let log
  let activeSpan
  // Test double for the native ThreadContext class. Captures the constructor
  // arguments and exposes the same surface (appendAttributes,
  // isTruncated, debugBytes).
  let StubThreadContext
  let constructedContexts
  // Tracks every activation of a context (or detach via clearContext).
  // ThreadContext.prototype.enter delegates to setActive(this); the stub's
  // clearContext delegates to setActive(undefined). getContext returns
  // activeContext. This is the test-side equivalent of the
  // AsyncLocalStorage that the real implementation uses.
  let activeContext
  let setActive

  function loadModule (overrides = {}) {
    return proxyquire.noPreserveCache()('../src/otel-thread-ctx', {
      '@datadog/pprof': overrides.pprof || pprofStub,
      '../../datadog-core/src/storage': overrides.storage || storageStub,
      './storage-channels': overrides.storageChannels || storageChannelsStub,
      './web-tags-cache': overrides.webTagsCache || webTagsCacheStub,
      './log': overrides.log || log,
    })
  }

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    enterCh = dc.channel('dd-trace:storage:enter')
    spanFinishCh = dc.channel('dd-trace:span:finish')
    tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
    webTagsResolvedCh = dc.channel('dd-trace:web-tags:resolved')
    // Test-owned answers for the shared web-tags cache: getCachedWebTags
    // returns whatever the current test seeded via cachedWebTags. Publishing
    // on webTagsResolvedCh simulates the shared cache's late-transition
    // event. Bypasses the real web-tags-cache so this spec doesn't depend
    // on its subscription lifecycle.
    cachedWebTags = new WeakMap()

    activeSpan = null
    activeContext = undefined
    constructedContexts = []
    setActive = sinon.stub().callsFake(c => { activeContext = c })

    StubThreadContext = class StubThreadContext {
      constructor (traceId, spanId, attributes) {
        this.traceId = traceId
        this.spanId = spanId
        this.attributes = attributes
        this.appendAttributes = sinon.stub()
        this.isTruncated = sinon.stub().returns(false)
        constructedContexts.push(this)
      }

      enter () { setActive(this) }
    }

    pprofStub = {
      '@noCallThru': true,
      otelThreadCtx: {
        ThreadContext: StubThreadContext,
        getContext: sinon.stub().callsFake(() => activeContext),
        clearContext: sinon.stub().callsFake(() => setActive()),
      },
    }

    storageStub = { '@noCallThru': true, isACFActive: true }

    storageChannelsStub = {
      enterCh,
      spanFinishCh,
      tagsUpdateCh,
      beforeCh: dc.channel('dd-trace:storage:before'),
      getActiveSpan: () => activeSpan,
      ensureChannelsActivated: sinon.stub(),
    }

    webTagsCacheStub = {
      '@noCallThru': true,
      getCachedWebTags: span => cachedWebTags.get(span),
      resolvedCh: webTagsResolvedCh,
    }

    log = {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    }
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    // Unsubscribe anything the test left attached so subsequent tests
    // get a clean slate. (dc-polyfill caches channels globally so the
    // same enterCh object lives across tests.)
    for (const ch of [enterCh, spanFinishCh, tagsUpdateCh, webTagsResolvedCh]) {
      const subs = [...ch._subscribers || []]
      for (const s of subs) ch.unsubscribe(s)
    }
  })

  describe('start()', () => {
    it('returns false on non-Linux platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const m = loadModule()
      assert.equal(m.start(), false)
      sinon.assert.notCalled(setActive)
    })

    it('returns false when AsyncContextFrame is inactive', () => {
      const m = loadModule({ storage: { '@noCallThru': true, isACFActive: false } })
      assert.equal(m.start(), false)
      sinon.assert.calledWithMatch(log.warn, /AsyncContextFrame/)
    })

    it('returns false when @datadog/pprof is missing the otelThreadCtx API', () => {
      const m = loadModule({ pprof: { '@noCallThru': true /* no otelThreadCtx */ } })
      assert.equal(m.start(), false)
      sinon.assert.calledWithMatch(log.warn, /otelThreadCtx API/)
    })

    it('returns false when otelThreadCtx is missing getContext/clearContext/ThreadContext', () => {
      const m = loadModule({
        pprof: {
          '@noCallThru': true,
          otelThreadCtx: { ThreadContext: StubThreadContext /* no getContext/clearContext */ },
        },
      })
      assert.equal(m.start(), false)
      sinon.assert.calledWithMatch(log.warn, /otelThreadCtx API/)
    })
  })

  describe('subscribed behavior', () => {
    let otelThreadCtx

    beforeEach(() => {
      otelThreadCtx = loadModule()
      assert.equal(otelThreadCtx.start(), true)
    })

    it('clearContext when no active span', () => {
      enterCh.publish()
      sinon.assert.calledOnce(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.calledOnceWithExactly(setActive)
      assert.equal(constructedContexts.length, 0)
    })

    // Stable per-thread values the writer bakes into every record. Matches
    // the constants computed at otel-thread-ctx.js module load.
    const { isMainThread, threadId } = require('node:worker_threads')
    const THREAD_NAME = (isMainThread ? 'Main' : `Worker #${threadId}`) + ' Event Loop'
    const THREAD_ID_STR = String(threadId)

    it('builds and installs a ThreadContext with bytes + local-root-span id for a non-web span', () => {
      activeSpan = makeSpan()
      enterCh.publish()
      assert.equal(constructedContexts.length, 1)
      const context = constructedContexts[0]
      assert.deepEqual(context.traceId, TRACE_ID_BYTES)
      assert.deepEqual(context.spanId, SPAN_ID_BYTES)
      // [0]=local root id (self), [1]=endpoint (hole), [2]=thread name, [3]=thread id.
      const expected = []
      expected[0] = SPAN_ID_HEX
      expected[2] = THREAD_NAME
      expected[3] = THREAD_ID_STR
      assert.deepEqual(context.attributes, expected)
      sinon.assert.calledOnceWithExactly(setActive, context)
    })

    it('builds a ThreadContext with the endpoint attribute for a web-server span', () => {
      const webTags = { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      // [0]=local root, [1]=endpoint, [2]=thread name, [3]=thread id.
      assert.deepEqual(constructedContexts[0].attributes,
        [SPAN_ID_HEX, 'GET /x', THREAD_NAME, THREAD_ID_STR])
    })

    it('encodes the local-root-span id from the first started-spans entry', () => {
      const rootHex = '99aabbccddeeff00'
      const rootSpan = makeSpan({ spanId: rootHex })
      activeSpan = makeSpan({ parentId: rootHex })
      // Plant the root in the started-spans list of the active span's trace.
      activeSpan.context = function () {
        return {
          _spanId: SPAN_ID_HEX,
          _parentId: rootHex,
          _trace: { started: [rootSpan] },
          toTraceId: () => TRACE_ID_HEX.padStart(32, '0'),
          toSpanId: () => SPAN_ID_HEX.padStart(16, '0'),
          getTags: () => ({}),
        }
      }
      enterCh.publish()
      assert.equal(constructedContexts[0].attributes[0], rootHex)
    })

    it('skips re-entering on re-entry when the same context is already active', () => {
      activeSpan = makeSpan()
      enterCh.publish()
      sinon.assert.calledOnce(setActive)
      assert.equal(constructedContexts.length, 1)

      // Second enter for the same span: getContext returns the same context,
      // enter() should not fire again.
      enterCh.publish()
      sinon.assert.calledOnce(setActive)
      assert.equal(constructedContexts.length, 1)
    })

    it('re-installs the same context when the active context drifts to another span and back', () => {
      const span1 = makeSpan({ spanId: SPAN_ID_HEX })
      const span2 = makeSpan({ spanId: '2122232425262728' })

      activeSpan = span1
      enterCh.publish()
      const context1 = constructedContexts[0]

      activeSpan = span2
      enterCh.publish()
      const context2 = constructedContexts[1]
      assert.notEqual(context1, context2)

      activeSpan = span1
      enterCh.publish()
      // No new context built — the cache on span1 returned the original.
      assert.equal(constructedContexts.length, 2)
      // enter() was called three times total.
      assert.equal(setActive.callCount, 3)
      assert.equal(setActive.thirdCall.args[0], context1)
    })

    it('spanFinish clears the writer when the finishing span is the active record', () => {
      activeSpan = makeSpan()
      enterCh.publish()
      sinon.assert.calledOnce(setActive)

      pprofStub.otelThreadCtx.clearContext.resetHistory()
      setActive.resetHistory()
      spanFinishCh.publish(activeSpan)
      sinon.assert.calledOnce(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.calledOnceWithExactly(setActive)
    })

    it('spanFinish does not clear the writer when the record belongs to a different span', () => {
      const span1 = makeSpan({ spanId: SPAN_ID_HEX })
      const span2 = makeSpan({ spanId: '2122232425262728' })

      activeSpan = span1
      enterCh.publish()
      activeSpan = span2
      enterCh.publish()
      // Writer's record is now span2's context; finishing span1 should leave it alone.
      pprofStub.otelThreadCtx.clearContext.resetHistory()
      setActive.resetHistory()
      spanFinishCh.publish(span1)
      sinon.assert.notCalled(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.notCalled(setActive)
    })

    it('spanFinish is a no-op for a span that was never the active record', () => {
      spanFinishCh.publish(makeSpan())
      sinon.assert.notCalled(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.notCalled(setActive)
    })

    it('tagsUpdate appends endpoint when the shared cache now has final routing tags', () => {
      activeSpan = makeSpan({ tags: {} })
      // No web tags cached at build time → context is built without an
      // endpoint and left with `needsEndpoint = true`.
      enterCh.publish()
      const context = constructedContexts[0]
      sinon.assert.notCalled(context.appendAttributes)

      // Simulate the shared cache picking up http.method + http.route on
      // this span; on the next tagsUpdate we should append the endpoint.
      cachedWebTags.set(activeSpan,
        { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' })
      tagsUpdateCh.publish(activeSpan)
      sinon.assert.calledOnce(context.appendAttributes)
      // Endpoint lands at index 1 (local-root-span id occupies index 0).
      const appended = context.appendAttributes.firstCall.args[0]
      assert.equal(appended[1], 'GET /x')
    })

    it('defers the endpoint until http.route arrives (method-only is not final)', () => {
      // Simulates the common HTTP server flow: `span.type=web` and
      // `http.method` set on request start, `http.route` added later by
      // the routing plugin.
      const webTags = { 'span.type': 'web', 'http.method': 'GET' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      const context = constructedContexts[0]
      // Endpoint is not final yet — no endpoint in the initial attrs.
      assert.strictEqual(context.attributes[1], undefined)

      // Route arrives on a subsequent tagsUpdate.
      webTags['http.route'] = '/x'
      tagsUpdateCh.publish(activeSpan)
      sinon.assert.calledOnce(context.appendAttributes)
      assert.equal(context.appendAttributes.firstCall.args[0][1], 'GET /x')
    })

    it('does not re-append the endpoint once it has been written', () => {
      // Final endpoint at build time → nothing to append on subsequent
      // tagsUpdate events, even if the tag bag continues to mutate.
      const webTags = { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      const context = constructedContexts[0]
      sinon.assert.notCalled(context.appendAttributes)

      webTags['http.status_code'] = '200'
      tagsUpdateCh.publish(activeSpan)
      sinon.assert.notCalled(context.appendAttributes)
    })

    it('tagsUpdate is a no-op when the span has not been entered yet', () => {
      const span = makeSpan({ tags: { 'span.type': 'web' } })
      cachedWebTags.set(span,
        { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' })
      tagsUpdateCh.publish(span)
      assert.equal(constructedContexts.length, 0)
    })
  })
})
