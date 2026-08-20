'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./setup/core')

const spanProjections = {
  getOwnWebTags: sinon.spy(span => span.tags),
  getParentSpan: sinon.spy(span => span.parent),
}
const webTagsCache = proxyquire('../src/web-tags-cache', {
  './opentracing/span-projections': spanProjections,
})

// One trace's started-spans list, shared by every span the helpers below build,
// mirroring how DatadogSpanContext._trace.started is shared across a trace. The
// cache walks it to find a span's parent.
function makeTrace () {
  return { started: [] }
}

function makeSpan (trace, { spanId, parentId, tags = {} } = {}) {
  const span = {
    parent: trace.started.find(candidate => candidate.spanId === parentId),
    spanId,
    tags,
  }
  trace.started.push(span)
  return span
}

const WEB = { 'span.type': 'web' }

describe('web-tags-cache', () => {
  let tagsUpdateCh
  let resolved, endpointResolved
  let subscribersBefore

  function tagsUpdateSubscriberCount () {
    return tagsUpdateCh._subscribers?.length ?? 0
  }

  beforeEach(() => {
    tagsUpdateCh = dc.channel('dd-trace:span:tags:update')
    // Measured before activating rather than assumed to be zero: the channel is
    // process-global and another spec in this process may hold subscribers.
    subscribersBefore = tagsUpdateSubscriberCount()
    resolved = sinon.stub()
    endpointResolved = sinon.stub()
    webTagsCache.resolvedCh.subscribe(resolved)
    webTagsCache.endpointResolvedCh.subscribe(endpointResolved)
    webTagsCache.activate()
  })

  afterEach(() => {
    webTagsCache.deactivate()
    webTagsCache.resolvedCh.unsubscribe(resolved)
    webTagsCache.endpointResolvedCh.unsubscribe(endpointResolved)
    // The cache is a module singleton; an unbalanced activate() would keep its
    // tagsUpdate subscription installed for every later spec in the process.
    assert.equal(tagsUpdateSubscriberCount(), subscribersBefore)
  })

  describe('getCachedWebTags()', () => {
    it('resolves a web-server span to its own tag bag', () => {
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET' }
      const span = makeSpan(trace, { spanId: 'a', tags })
      assert.equal(webTagsCache.getCachedWebTags(span), tags)
    })

    it('resolves a child to its nearest web-server ancestor tag bag', () => {
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET' }
      makeSpan(trace, { spanId: 'a', tags })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      const grandchild = makeSpan(trace, { spanId: 'c', parentId: 'b' })
      assert.equal(webTagsCache.getCachedWebTags(grandchild), tags)
      assert.equal(webTagsCache.getCachedWebTags(child), tags)
    })

    it('resolves to undefined when no ancestor is a web-server span', () => {
      const trace = makeTrace()
      makeSpan(trace, { spanId: 'a' })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
    })

    it('walks the parent chain once and caches the answer', () => {
      const trace = makeTrace()
      const tags = { ...WEB }
      makeSpan(trace, { spanId: 'a', tags })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      const symbols = Object.getOwnPropertySymbols(child)
      const callsBefore = spanProjections.getOwnWebTags.callCount
      assert.equal(webTagsCache.getCachedWebTags(child), tags)
      const callsAfterFirst = spanProjections.getOwnWebTags.callCount
      assert.equal(webTagsCache.getCachedWebTags(child), tags)
      assert.ok(callsAfterFirst > callsBefore)
      assert.equal(spanProjections.getOwnWebTags.callCount, callsAfterFirst)
      assert.deepStrictEqual(Object.getOwnPropertySymbols(child), symbols)
    })
  })

  describe('resolvedCh', () => {
    it('announces a span that becomes a web-server span after its first lookup', () => {
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      assert.equal(webTagsCache.getCachedWebTags(span), undefined)

      Object.assign(tags, WEB)
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(resolved)
      sinon.assert.calledWith(resolved, span)
      assert.equal(webTagsCache.getCachedWebTags(span), tags)
    })

    it('announces the promotion only once', () => {
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      Object.assign(tags, WEB)
      tagsUpdateCh.publish(span)
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(resolved)
    })

    it('stays silent for a span that never becomes a web-server span', () => {
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      tags['http.method'] = 'GET'
      tagsUpdateCh.publish(span)
      sinon.assert.notCalled(resolved)
    })

    it('stays silent for a span that was never looked up', () => {
      const trace = makeTrace()
      const span = makeSpan(trace, { spanId: 'a', tags: { ...WEB } })
      tagsUpdateCh.publish(span)
      sinon.assert.notCalled(resolved)
    })
  })

  describe('endpointResolvedCh', () => {
    it('announces a web-server span once its endpoint name settles', () => {
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET' }
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      tags['http.status_code'] = '200'
      tagsUpdateCh.publish(span)
      sinon.assert.notCalled(endpointResolved)

      tags['http.route'] = '/x'
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(endpointResolved)
      sinon.assert.calledWith(endpointResolved, span)
    })

    it('keeps waiting while resource.name is still the bare request method', () => {
      // datadog-plugin-next's shape — see finalEndpoint in webspan-utils.
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET', 'resource.name': 'GET' }
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      tagsUpdateCh.publish(span)
      sinon.assert.notCalled(endpointResolved)

      tags['resource.name'] = 'GET /page'
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(endpointResolved)
      sinon.assert.calledWith(endpointResolved, span)
    })

    it('announces the endpoint only once', () => {
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET', 'http.route': '/x' }
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      tagsUpdateCh.publish(span)
      tags['http.route'] = '/y'
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(endpointResolved)
    })

    it('announces the web-server span rather than the descendant being updated', () => {
      // The endpoint belongs to the request; a descendant's own tag updates say
      // nothing about it, and its cached bag is the ancestor's, not its own. The
      // child carries a `resource.name` of its own — as every db or http-client
      // span does — which is a settled endpoint name by itself, so finality has
      // to be judged against the request's tag bag and not whichever bag the
      // updated span happens to own.
      const trace = makeTrace()
      const tags = { ...WEB, 'http.method': 'GET', 'http.route': '/x' }
      const parent = makeSpan(trace, { spanId: 'a', tags })
      const child = makeSpan(trace, {
        spanId: 'b',
        parentId: 'a',
        tags: { 'span.type': 'sql', 'resource.name': 'SELECT * FROM users' },
      })
      assert.equal(webTagsCache.getCachedWebTags(child), tags)

      tagsUpdateCh.publish(child)
      sinon.assert.notCalled(endpointResolved)

      tagsUpdateCh.publish(parent)
      sinon.assert.calledOnce(endpointResolved)
      sinon.assert.calledWith(endpointResolved, parent)
    })

    it('announces a span promoted to web-server with a settled endpoint in one update', () => {
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      Object.assign(tags, WEB, { 'http.method': 'GET', 'http.route': '/x' })
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(resolved)
      sinon.assert.calledWith(resolved, span)
      sinon.assert.calledOnce(endpointResolved)
      sinon.assert.calledWith(endpointResolved, span)
    })
  })

  describe('activate() / deactivate()', () => {
    it('is ref-counted across consumers', () => {
      // beforeEach already activated once, so the cache is live here.
      webTagsCache.activate()
      webTagsCache.deactivate()

      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)
      Object.assign(tags, WEB)
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(resolved)
    })

    it('stops observing tag updates once the last consumer deactivates', () => {
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)

      webTagsCache.deactivate()
      Object.assign(tags, WEB)
      tagsUpdateCh.publish(span)
      sinon.assert.notCalled(resolved)

      // Restore the balance afterEach asserts on.
      webTagsCache.activate()
    })

    it('ignores a deactivate() with no matching activate()', () => {
      webTagsCache.deactivate()
      webTagsCache.deactivate()
      // The extra deactivate() must not drive the refcount negative, or the next
      // activate() would leave the cache observing nothing.
      webTagsCache.activate()
      const trace = makeTrace()
      const tags = {}
      const span = makeSpan(trace, { spanId: 'a', tags })
      webTagsCache.getCachedWebTags(span)
      Object.assign(tags, WEB)
      tagsUpdateCh.publish(span)
      sinon.assert.calledOnce(resolved)
    })
  })
})
