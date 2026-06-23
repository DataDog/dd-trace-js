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

// A web-server span plus a child that resolves to it through the shared cache,
// as webTagsCache.getCachedWebTags does for any descendant of a request span.
// Both spans share one tag bag object, which is what the writer keys pending
// endpoint records on.
function makeWebSpanWithChild (webTags) {
  const parent = makeSpan({ tags: webTags })
  const child = makeSpan({ spanId: '2122232425262728', parentId: SPAN_ID_HEX, tags: {} })
  return { parent, child, webTags }
}

describe('otel-thread-ctx', () => {
  let platformDescriptor
  let pprofStub
  let enterCh, spanFinishCh, tagsUpdateCh
  let webTagsResolvedCh, endpointResolvedCh
  let webTagsCacheStub
  let cachedWebTags
  let storageChannelsStub
  let storageStub
  let log
  let activeSpan
  // Test double for the native ThreadContext class. Captures the constructor
  // arguments and exposes the same surface (appendAttributes, invalidate,
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
    endpointResolvedCh = dc.channel('dd-trace:web-tags:endpoint-resolved')
    // Test-owned answers for the shared web-tags cache: getCachedWebTags
    // returns whatever the current test seeded via cachedWebTags. Publishing
    // on webTagsResolvedCh / endpointResolvedCh simulates the shared cache's
    // transition events (web-tags-cache.spec.js pins when it really fires
    // them). Bypasses the real web-tags-cache so this spec doesn't depend
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
        this.invalidate = sinon.stub()
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
      endpointResolvedCh,
      activate: sinon.stub(),
      deactivate: sinon.stub(),
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
    for (const ch of [enterCh, spanFinishCh, tagsUpdateCh, webTagsResolvedCh, endpointResolvedCh]) {
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

    it('spanFinish invalidates the record and clears the writer when the finishing span is active', () => {
      activeSpan = makeSpan()
      enterCh.publish()
      sinon.assert.calledOnce(setActive)
      const context = constructedContexts[0]

      pprofStub.otelThreadCtx.clearContext.resetHistory()
      setActive.resetHistory()
      spanFinishCh.publish(activeSpan)
      sinon.assert.calledOnceWithExactly(context.invalidate)
      sinon.assert.calledOnce(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.calledOnceWithExactly(setActive)
    })

    it('spanFinish invalidates the finished span record even when another span holds the writer', () => {
      // The finishing frame need not be the one holding the finished span's
      // context: sibling frames and continuations the span scheduled before
      // finishing inherit the same ThreadContext reference, and in ACF mode no
      // later storage event fires in them to overwrite the record. Invalidating
      // it drops the finished span out of scope for all of them at once, while
      // the current frame's own (span2) record must stay attached.
      const span1 = makeSpan({ spanId: SPAN_ID_HEX })
      const span2 = makeSpan({ spanId: '2122232425262728' })

      activeSpan = span1
      enterCh.publish()
      activeSpan = span2
      enterCh.publish()
      const [context1, context2] = constructedContexts

      pprofStub.otelThreadCtx.clearContext.resetHistory()
      setActive.resetHistory()
      spanFinishCh.publish(span1)
      sinon.assert.calledOnceWithExactly(context1.invalidate)
      sinon.assert.notCalled(context2.invalidate)
      sinon.assert.notCalled(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.notCalled(setActive)
      assert.equal(activeContext, context2)
    })

    it('spanFinish is a no-op for a span that was never the active record', () => {
      spanFinishCh.publish(makeSpan())
      sinon.assert.notCalled(pprofStub.otelThreadCtx.clearContext)
      sinon.assert.notCalled(setActive)
    })

    it('spanFinish published twice for the same span invalidates the record once', () => {
      activeSpan = makeSpan()
      enterCh.publish()
      const context = constructedContexts[0]

      spanFinishCh.publish(activeSpan)
      pprofStub.otelThreadCtx.clearContext.resetHistory()
      spanFinishCh.publish(activeSpan)
      sinon.assert.calledOnce(context.invalidate)
      sinon.assert.notCalled(pprofStub.otelThreadCtx.clearContext)
    })

    it('builds a fresh context when a finished span is entered again', () => {
      // The per-span cache is dropped on finish, so a late enter can't
      // re-install the invalidated record — it gets a new, valid one. Deliberate:
      // an enter is the tracer naming the active span, unlike the inherited
      // frames invalidate() exists for, and work running under a finished request
      // span still belongs to that request. See onSpanFinished.
      activeSpan = makeSpan()
      enterCh.publish()
      const context = constructedContexts[0]
      spanFinishCh.publish(activeSpan)

      enterCh.publish()
      assert.equal(constructedContexts.length, 2)
      const reentered = constructedContexts[1]
      assert.notEqual(reentered, context)
      sinon.assert.notCalled(reentered.invalidate)
      assert.equal(activeContext, reentered)
    })

    it('writes the endpoint at build time once its value has settled', () => {
      const webTags = { 'span.type': 'web', 'http.method': 'GET', 'resource.name': 'GET /page' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      assert.equal(constructedContexts[0].attributes[1], 'GET /page')
      sinon.assert.notCalled(constructedContexts[0].appendAttributes)
    })

    it('appends the endpoint to the request span record when the cache announces it', () => {
      // Simulates the common HTTP server flow: `span.type=web` and
      // `http.method` set on request start, `http.route` added later by the
      // routing plugin.
      const webTags = { 'span.type': 'web', 'http.method': 'GET' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      const context = constructedContexts[0]
      // Endpoint is not settled yet — no endpoint in the initial attrs.
      assert.strictEqual(context.attributes[1], undefined)

      webTags['http.route'] = '/x'
      endpointResolvedCh.publish(activeSpan)
      sinon.assert.calledOnce(context.appendAttributes)
      // Endpoint lands at index 1 (local-root-span id occupies index 0).
      assert.equal(context.appendAttributes.firstCall.args[0][1], 'GET /x')
    })

    it('appends the endpoint to records of descendants built before it settled', () => {
      // The routing tags land on the request span, so the announcement names
      // that span — but each descendant has its own record with its own
      // endpoint copy, and those built during the deferral window are the ones
      // that would otherwise never get one.
      const { parent, child, webTags } = makeWebSpanWithChild({ 'span.type': 'web', 'http.method': 'GET' })
      cachedWebTags.set(parent, webTags)
      cachedWebTags.set(child, webTags)

      activeSpan = parent
      enterCh.publish()
      activeSpan = child
      enterCh.publish()
      const [parentContext, childContext] = constructedContexts
      assert.strictEqual(childContext.attributes[1], undefined)

      webTags['http.route'] = '/x'
      endpointResolvedCh.publish(parent)
      for (const context of [parentContext, childContext]) {
        sinon.assert.calledOnce(context.appendAttributes)
        assert.equal(context.appendAttributes.firstCall.args[0][1], 'GET /x')
      }
    })

    it('does not append to the record of a descendant that finished before the endpoint settled', () => {
      // onSpanFinished already invalidated that record; appending to it would
      // write into a record no reader should be looking at any more.
      const { parent, child, webTags } = makeWebSpanWithChild({ 'span.type': 'web', 'http.method': 'GET' })
      cachedWebTags.set(parent, webTags)
      cachedWebTags.set(child, webTags)

      activeSpan = parent
      enterCh.publish()
      activeSpan = child
      enterCh.publish()
      const [parentContext, childContext] = constructedContexts
      spanFinishCh.publish(child)

      webTags['http.route'] = '/x'
      endpointResolvedCh.publish(parent)
      sinon.assert.notCalled(childContext.appendAttributes)
      sinon.assert.calledOnce(parentContext.appendAttributes)
    })

    it('appends the endpoint only once per record', () => {
      const { parent, child, webTags } = makeWebSpanWithChild({ 'span.type': 'web', 'http.method': 'GET' })
      cachedWebTags.set(parent, webTags)
      cachedWebTags.set(child, webTags)

      activeSpan = parent
      enterCh.publish()
      activeSpan = child
      enterCh.publish()

      webTags['http.route'] = '/x'
      endpointResolvedCh.publish(parent)
      // A second announcement for the same request (the cache guarantees one,
      // but the waiters are gone either way) must not append again.
      endpointResolvedCh.publish(parent)
      for (const context of constructedContexts) {
        sinon.assert.calledOnce(context.appendAttributes)
      }
    })

    it('does not append an endpoint that is still a placeholder when announced', () => {
      const webTags = { 'span.type': 'web', 'http.method': 'GET', 'resource.name': 'GET' }
      activeSpan = makeSpan({ tags: webTags })
      cachedWebTags.set(activeSpan, webTags)
      enterCh.publish()
      const context = constructedContexts[0]
      assert.strictEqual(context.attributes[1], undefined)

      endpointResolvedCh.publish(activeSpan)
      sinon.assert.notCalled(context.appendAttributes)
    })

    it('appends the endpoint when a span is only recognized as a web-server span later', () => {
      // The record was built when the span had no web-server ancestry at all,
      // so it never enlisted for a request; webTagsCache announces the
      // promotion separately via resolvedCh. A promoted span's cached bag is
      // its own tag object, which is what the cache stores.
      const tags = {}
      activeSpan = makeSpan({ tags })
      enterCh.publish()
      const context = constructedContexts[0]
      sinon.assert.notCalled(context.appendAttributes)

      Object.assign(tags, { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' })
      cachedWebTags.set(activeSpan, tags)
      webTagsResolvedCh.publish(activeSpan)
      sinon.assert.calledOnce(context.appendAttributes)
      assert.equal(context.appendAttributes.firstCall.args[0][1], 'GET /x')
    })

    it('waits for the endpoint when a late web-server span has not resolved it yet', () => {
      const tags = {}
      activeSpan = makeSpan({ tags })
      enterCh.publish()
      const context = constructedContexts[0]

      // Recognized as a web-server span, but the endpoint is still a placeholder:
      // the record has to be enlisted at this point rather than written.
      Object.assign(tags, { 'span.type': 'web', 'http.method': 'GET' })
      cachedWebTags.set(activeSpan, tags)
      webTagsResolvedCh.publish(activeSpan)
      sinon.assert.notCalled(context.appendAttributes)

      tags['http.route'] = '/x'
      endpointResolvedCh.publish(activeSpan)
      sinon.assert.calledOnce(context.appendAttributes)
      assert.equal(context.appendAttributes.firstCall.args[0][1], 'GET /x')
    })

    it('endpoint announcements are a no-op for a span that has not been entered', () => {
      const { parent, webTags } = makeWebSpanWithChild(
        { 'span.type': 'web', 'http.method': 'GET', 'http.route': '/x' })
      cachedWebTags.set(parent, webTags)
      endpointResolvedCh.publish(parent)
      webTagsResolvedCh.publish(parent)
      assert.equal(constructedContexts.length, 0)
    })
  })
})
