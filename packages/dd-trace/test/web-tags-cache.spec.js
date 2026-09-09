'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const dc = require('dc-polyfill')
const sinon = require('sinon')

require('./setup/core')

const webTagsCache = require('../src/web-tags-cache')

// One trace's started-spans list, shared by every span the helpers below build,
// mirroring how DatadogSpanContext._trace.started is shared across a trace. The
// cache walks it to find a span's parent.
function makeTrace () {
  return { started: [] }
}

// One context object per span, as DatadogSpan#context() returns — a spy on its
// getTags then counts how often the cache actually walks that span.
function makeSpan (trace, { spanId, parentId, tags = {} } = {}) {
  const context = {
    _spanId: spanId,
    _parentId: parentId,
    _trace: trace,
    getTags: () => tags,
  }
  const span = { context: () => context, tags }
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
      const parent = makeSpan(trace, { spanId: 'a', tags })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      const getTags = sinon.spy(parent.context(), 'getTags')
      assert.equal(webTagsCache.getCachedWebTags(child), tags)
      assert.equal(getTags.callCount, 1)
      assert.equal(webTagsCache.getCachedWebTags(child), tags)
      assert.equal(getTags.callCount, 1)
    })

    it('does not re-walk an empty answer while nothing has been promoted', () => {
      const trace = makeTrace()
      makeSpan(trace, { spanId: 'a' })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      const getTags = sinon.spy(child.context(), 'getTags')
      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      assert.equal(getTags.callCount, 1)
      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      assert.equal(getTags.callCount, 1)
    })

    it('leaves a span outside the promoted span\'s subtree alone', () => {
      // A promotion rewrites the answers of the promoted span's descendants and
      // nothing else: a sibling subtree cannot have it as an ancestor, so it is
      // neither re-examined nor announced.
      const trace = makeTrace()
      const parent = makeSpan(trace, { spanId: 'a', tags: {} })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      const getTags = sinon.spy(child.context(), 'getTags')

      const sibling = makeSpan(trace, { spanId: 'z', parentId: 'a', tags: {} })
      webTagsCache.getCachedWebTags(sibling)
      Object.assign(sibling.tags, WEB)
      tagsUpdateCh.publish(sibling)

      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      assert.equal(getTags.callCount, 0)
      sinon.assert.neverCalledWith(resolved, child)

      // Its own ancestor being promoted is what resolves it.
      Object.assign(parent.tags, WEB)
      tagsUpdateCh.publish(parent)
      assert.equal(webTagsCache.getCachedWebTags(child), parent.tags)
    })

    it('does not scan the started-spans list for a parent a span cannot have', () => {
      const trace = makeTrace()
      const other = makeSpan(trace, { spanId: 'a', tags: {} })
      const root = makeSpan(trace, { spanId: 'b' })
      const context = sinon.spy(other, 'context')

      assert.equal(webTagsCache.getCachedWebTags(root), undefined)
      assert.equal(context.callCount, 0)
    })

    it('does not look at spans created before the promoted one', () => {
      // Creation order rules them out as descendants, so the sweep must not pay
      // a context() call for each of them. Worth pinning: a long-lived trace can
      // hold a large prefix, and every web-server span promoted in it would walk
      // that prefix again.
      const trace = makeTrace()
      const older = makeSpan(trace, { spanId: 'a', tags: {} })
      const promoted = makeSpan(trace, { spanId: 'b', tags: {} })
      const child = makeSpan(trace, { spanId: 'c', parentId: 'b' })
      // Created after the promoted span but under the older one: visited by the
      // sweep, and left alone because the promotion is not in its ancestry.
      const unrelated = makeSpan(trace, { spanId: 'd', parentId: 'a' })
      webTagsCache.getCachedWebTags(older)
      webTagsCache.getCachedWebTags(child)
      webTagsCache.getCachedWebTags(unrelated)

      const context = sinon.spy(older, 'context')
      Object.assign(promoted.tags, WEB)
      tagsUpdateCh.publish(promoted)

      assert.equal(context.callCount, 0)
      assert.equal(webTagsCache.getCachedWebTags(child), promoted.tags)
      assert.equal(webTagsCache.getCachedWebTags(unrelated), undefined)
    })

    it('leaves another trace alone when a span is promoted', () => {
      // Promotions are per trace: the walk never leaves its own _trace.started, so
      // another trace's request span cannot be this span's ancestor.
      const traceA = makeTrace()
      makeSpan(traceA, { spanId: 'a' })
      const child = makeSpan(traceA, { spanId: 'b', parentId: 'a' })
      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      const getTags = sinon.spy(child.context(), 'getTags')

      const traceB = makeTrace()
      const requestSpan = makeSpan(traceB, { spanId: 'c', tags: {} })
      webTagsCache.getCachedWebTags(requestSpan)
      Object.assign(requestSpan.tags, WEB)
      tagsUpdateCh.publish(requestSpan)

      assert.equal(webTagsCache.getCachedWebTags(child), undefined)
      assert.equal(getTags.callCount, 0)
    })

    it('resolves a descendant that cached an empty answer once an ancestor is promoted', () => {
      // The window this exists for: TracingPlugin.startSpan activates a span
      // before addRequestTags sets span.type, so a child created in between walks
      // past an ancestor that is about to become a web-server span.
      const trace = makeTrace()
      const parent = makeSpan(trace, { spanId: 'a', tags: {} })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      const grandchild = makeSpan(trace, { spanId: 'c', parentId: 'b' })
      assert.equal(webTagsCache.getCachedWebTags(grandchild), undefined)

      Object.assign(parent.tags, WEB, { 'http.method': 'GET', 'http.route': '/x' })
      tagsUpdateCh.publish(parent)

      assert.equal(webTagsCache.getCachedWebTags(child), parent.tags)
      assert.equal(webTagsCache.getCachedWebTags(grandchild), parent.tags)
    })

    it('repoints a descendant at a nearer web-server span promoted later', () => {
      // Nested request handling: the inner request span is created under the
      // outer one and only becomes a web-server span afterwards, by which time
      // its descendants are attributed to the outer request.
      const trace = makeTrace()
      const outer = makeSpan(trace, { spanId: 'a', tags: { ...WEB } })
      const inner = makeSpan(trace, { spanId: 'b', parentId: 'a', tags: {} })
      const child = makeSpan(trace, { spanId: 'c', parentId: 'b' })
      assert.equal(webTagsCache.getCachedWebTags(child), outer.tags)

      Object.assign(inner.tags, WEB)
      tagsUpdateCh.publish(inner)

      assert.equal(webTagsCache.getCachedWebTags(inner), inner.tags)
      assert.equal(webTagsCache.getCachedWebTags(child), inner.tags)
    })

    it('keeps a nearer web-server span\'s subtree on that span when an outer one is promoted', () => {
      // The outer promotion stops at the inner request span: everything under it
      // already has a closer answer, and the outer endpoint is not theirs.
      const trace = makeTrace()
      const outer = makeSpan(trace, { spanId: 'a', tags: {} })
      const inner = makeSpan(trace, { spanId: 'b', parentId: 'a', tags: { ...WEB } })
      const child = makeSpan(trace, { spanId: 'c', parentId: 'b' })
      const sibling = makeSpan(trace, { spanId: 'd', parentId: 'a' })
      assert.equal(webTagsCache.getCachedWebTags(child), inner.tags)
      assert.equal(webTagsCache.getCachedWebTags(sibling), undefined)

      Object.assign(outer.tags, WEB)
      tagsUpdateCh.publish(outer)

      assert.equal(webTagsCache.getCachedWebTags(child), inner.tags)
      assert.equal(webTagsCache.getCachedWebTags(sibling), outer.tags)
    })

    it('announces a descendant as soon as the ancestor is promoted, not on its next lookup', () => {
      // A descendant that keeps running without re-entering storage never asks
      // again, and is precisely the span samples are being attributed to.
      const trace = makeTrace()
      const parent = makeSpan(trace, { spanId: 'a', tags: {} })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      webTagsCache.getCachedWebTags(child)

      Object.assign(parent.tags, WEB)
      tagsUpdateCh.publish(parent)

      sinon.assert.calledWith(resolved, child)
      sinon.assert.calledTwice(resolved)
    })

    it('announces a resolved descendant only once', () => {
      const trace = makeTrace()
      const parent = makeSpan(trace, { spanId: 'a', tags: {} })
      const child = makeSpan(trace, { spanId: 'b', parentId: 'a' })
      webTagsCache.getCachedWebTags(child)

      Object.assign(parent.tags, WEB)
      tagsUpdateCh.publish(parent)
      resolved.resetHistory()

      tagsUpdateCh.publish(parent)
      webTagsCache.getCachedWebTags(child)
      sinon.assert.notCalled(resolved)
    })

    it('stays silent for a descendant that was never looked up', () => {
      const trace = makeTrace()
      const parent = makeSpan(trace, { spanId: 'a', tags: {} })
      makeSpan(trace, { spanId: 'b', parentId: 'a' })
      webTagsCache.getCachedWebTags(parent)

      Object.assign(parent.tags, WEB)
      tagsUpdateCh.publish(parent)

      sinon.assert.calledOnce(resolved)
      sinon.assert.calledWith(resolved, parent)
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
