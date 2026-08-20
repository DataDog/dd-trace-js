'use strict'

const assert = require('node:assert/strict')

const { EventWriter } = require('../../src/opentracing/event-writer')
const {
  getApiSecurityFramework,
  getApiSecurityHttpRoute,
  getAppSecRootSpan,
  getCodeHotspotIds,
  getHttpEndpoint,
  getLocalRootSpan,
  getParentSpan,
  hasUserId,
  hasUserSessionId,
  shouldCollectAppSecEventHeaders,
} = require('../../src/opentracing/span-projections')

describe('EventWriter', () => {
  let context
  let span
  let writer

  beforeEach(() => {
    writer = new EventWriter()
    context = {}
    writer.initializeContext(context, {
      traceId: 'trace-id',
      spanId: 'span-id',
    })
    context.getTags = () => Reflect.get(context, '_tags')
    context.getTag = key => context.getTags()[key]
    span = {
      context () {
        return context
      },
    }
    writer.startSpan(span, {
      context,
      processor: {},
      prioritySampler: {},
      debug: false,
      operationName: 'operation',
      integrationName: 'integration',
      startTime: 10,
      links: [],
    })
  })

  it('owns span creation and lifecycle writes', () => {
    assert.strictEqual(span._spanContext, context)
    assert.deepStrictEqual(context._trace.started, [span])
    assert.strictEqual(span._duration, undefined)

    assert.strictEqual(writer.finishSpan(span, 25), true)
    assert.strictEqual(writer.finishSpan(span, 30), false)
    assert.strictEqual(span._duration, 15)
    assert.deepStrictEqual(context._trace.finished, [span])
    assert.strictEqual(context._isFinished, true)
  })

  it('owns tag, trace, sampling, baggage, link and event writes', () => {
    writer.setTag(span, 'one', 1)
    writer.setTags(context, { two: 2 })
    assert.strictEqual(writer.setTagsIfTagMatches(span, 'owner', undefined, { owner: 'next', route: '/a' }), true)
    assert.strictEqual(writer.setTagsIfTagMatches(span, 'owner', 'other', { route: '/b' }), false)
    assert.strictEqual(writer.setTagIfAbsent(span, 'one', 3), false)
    assert.strictEqual(writer.setTagIfAbsent(span, 'three', 3), true)
    writer.deleteTag(context, 'two')

    writer.setTraceTag(span, '_dd.p.test', 'value')
    writer.setOrigin(context, 'synthetics')
    writer.setSamplingPriority(context, 2, 8)
    writer.setSpanSamplingDecision(context, { sampleRate: 0.5, maxPerSecond: 10 })
    writer.setBaggageItem(span, 'bag', 'value')
    writer.addLink(span, { context: 'linked' })
    writer.addEvent(span, { name: 'event' })

    assert.deepStrictEqual(context.getTags(), { one: 1, three: 3, owner: 'next', route: '/a' })
    assert.strictEqual(context._trace.tags['_dd.p.test'], 'value')
    assert.strictEqual(context._trace.origin, 'synthetics')
    assert.deepStrictEqual(context._sampling, { priority: 2, mechanism: 8 })
    assert.deepStrictEqual(context._spanSampling, { sampleRate: 0.5, maxPerSecond: 10 })
    assert.deepStrictEqual(context._baggageItems, { bag: 'value' })
    assert.deepStrictEqual(span._links, [{ context: 'linked' }])
    assert.deepStrictEqual(span._events, [{ name: 'event' }])
  })

  it('performs structured metadata updates atomically', () => {
    assert.strictEqual(writer.setStructuredTagIfAbsent(span, 'body', { first: true }), true)
    assert.strictEqual(writer.setStructuredTagIfAbsent(span, 'body', { second: true }), false)
    assert.strictEqual(writer.appendStackTrace(span, 'rasp', { id: 1 }, 1), true)
    assert.strictEqual(writer.appendStackTrace(span, 'rasp', { id: 2 }, 1), false)

    assert.deepStrictEqual(span.meta_struct, {
      body: { first: true },
      '_dd.stack': {
        rasp: [{ id: 1 }],
      },
    })
  })

  it('performs web and service finalization without exposing tags', () => {
    assert.strictEqual(writer.setWebRequestTagsIfAbsent(span, {
      'http.url': '/users/123?token=redacted',
      'http.method': 'GET',
    }), true)
    assert.strictEqual(writer.setWebRequestTagsIfAbsent(span, {
      'http.url': '/overwritten',
    }), false)

    writer.setTag(span, 'http.route', '/owned-route')
    assert.strictEqual(writer.setHttpEndpointIfAbsent(span, url => url.split('?')[0]), false)
    writer.deleteTag(span, 'http.route')
    assert.strictEqual(writer.setHttpEndpointIfAbsent(span, url => url.split('?')[0]), true)
    assert.strictEqual(writer.setHttpEndpointIfAbsent(span, () => '/overwritten'), false)
    assert.strictEqual(writer.setWebErrorIfAbsent(span, true), true)
    writer.setTag(span, 'error', false)
    writer.setTag(span, 'error.message', 'owned')
    assert.strictEqual(writer.setWebErrorIfAbsent(span, true), false)

    writer.setTag(span, 'http.route', '/users/:id')
    assert.strictEqual(writer.setWebResourceNameIfAbsent(span, 'GET'), true)
    assert.strictEqual(writer.setWebResourceNameIfAbsent(span, 'POST'), false)

    writer.setTags(span, {
      'service.name': 'web-service',
      '_dd.svc_src': 'web',
    })
    writer.resolveServiceSource(span, 'app', 'web-service', '_dd.svc_src', 'm')
    assert.strictEqual(context.getTag('_dd.svc_src'), 'web')
    writer.setTag(span, 'service.name', 'custom-service')
    writer.resolveServiceSource(span, 'app', 'web-service', '_dd.svc_src', 'm')

    assert.strictEqual(context.getTag('http.url'), '/users/123?token=redacted')
    assert.strictEqual(context.getTag('http.endpoint'), '/users/123')
    assert.strictEqual(context.getTag('resource.name'), 'GET /users/:id')
    assert.strictEqual(context.getTag('_dd.svc_src'), 'm')
  })

  it('projects topology and selected tags from writer events', () => {
    const childContext = {}
    writer.initializeContext(childContext, {
      traceId: 'trace-id',
      spanId: 'child-id',
      parentId: 'span-id',
      trace: context._trace,
    })
    const child = { context: () => childContext }
    writer.startSpan(child, {
      context: childContext,
      processor: {},
      prioritySampler: {},
      debug: false,
      operationName: 'child',
      integrationName: 'integration',
      startTime: 11,
      links: [],
    })

    writer.setTags(span, {
      component: 'express',
      'http.route': '/users/:id',
      'span.type': 'web',
      'http.endpoint': '/users/{id}',
      'appsec.events.users.login.success.track': 'true',
      'usr.id': '123',
      'usr.session_id': 'session',
    })

    assert.strictEqual(getParentSpan(child), span)
    assert.strictEqual(getLocalRootSpan(child), span)
    assert.strictEqual(getAppSecRootSpan(child), span)
    assert.deepStrictEqual(getCodeHotspotIds(child), {
      spanId: 'child-id',
      localRootSpanId: 'span-id',
    })
    assert.strictEqual(getHttpEndpoint(span), '/users/{id}')
    assert.strictEqual(getApiSecurityFramework(span), 'express')
    assert.strictEqual(getApiSecurityHttpRoute(span), '/users/:id')
    assert.strictEqual(hasUserId(span), true)
    assert.strictEqual(hasUserSessionId(span), true)
    assert.strictEqual(shouldCollectAppSecEventHeaders(span), true)

    writer.setTag(span, '_inferred_span', true)
    assert.strictEqual(getAppSecRootSpan(child), child)
  })

  it('performs AppSec sampling and event updates atomically', () => {
    span._prioritySampler = {
      sample: () => writer.setSamplingPriority(context, -1),
    }
    assert.strictEqual(writer.sampleForApiSecurity(span), false)

    writer.setTag(span, '_dd.origin', 'lambda')
    const firstJson = writer.addAppSecEvent(span, [{ id: 1 }], '127.0.0.1')
    const secondJson = writer.addAppSecEvent(span, [{ id: 2 }])

    assert.strictEqual(firstJson, '{"triggers":[{"id":1}]}')
    assert.strictEqual(secondJson, '{"triggers":[{"id":1},{"id":2}]}')
    assert.strictEqual(context.getTag('_dd.origin'), 'lambda')
    assert.strictEqual(context.getTag('network.client.ip'), '127.0.0.1')
  })

  it('preserves SDK-owned user tags in atomic AppSec updates', () => {
    writer.setTags(span, {
      '_dd.appsec.events.users.login.success.sdk': 'true',
      'appsec.events.users.login.success.usr.login': 'sdk-login',
      'usr.id': 'sdk-id',
    })

    const userIdWritten = writer.setAppSecAutoLoginTags(
      span,
      '_dd.appsec.events.users.login.success.sdk',
      {
        'appsec.events.users.login.success.track': 'true',
        'appsec.events.users.login.success.usr.login': 'auto-login',
        'usr.id': 'auto-id',
      },
      new Set(['appsec.events.users.login.success.usr.login', 'usr.id']),
      'usr.id'
    )

    assert.strictEqual(userIdWritten, false)
    assert.strictEqual(context.getTag('appsec.events.users.login.success.track'), 'true')
    assert.strictEqual(context.getTag('appsec.events.users.login.success.usr.login'), 'sdk-login')
    assert.strictEqual(context.getTag('usr.id'), 'sdk-id')

    writer.deleteTag(span, '_dd.appsec.events.users.login.success.sdk')
    assert.strictEqual(writer.setAppSecAutoLoginTags(
      span,
      '_dd.appsec.events.users.login.success.sdk',
      {
        'appsec.events.users.login.success.usr.login': 'auto-login',
        'usr.id': 'auto-id',
      },
      new Set(['appsec.events.users.login.success.usr.login', 'usr.id']),
      'usr.id'
    ), true)
    assert.strictEqual(context.getTag('appsec.events.users.login.success.usr.login'), 'auto-login')
    assert.strictEqual(context.getTag('usr.id'), 'auto-id')

    writer.setTag(span, '_dd.appsec.user.collection_mode', 'sdk')
    assert.strictEqual(writer.setAppSecAutoUser(span, 'blocked-id', 'identification'), false)
    assert.strictEqual(context.getTag('_dd.appsec.usr.id'), 'blocked-id')
    assert.strictEqual(context.getTag('usr.id'), 'auto-id')
    assert.strictEqual(context.getTag('_dd.appsec.user.collection_mode'), 'sdk')

    writer.setTag(span, '_dd.appsec.user.collection_mode', 'identification')
    assert.strictEqual(writer.setAppSecAutoUser(span, 'next-id', 'anonymization'), true)
    assert.strictEqual(context.getTag('_dd.appsec.usr.id'), 'next-id')
    assert.strictEqual(context.getTag('usr.id'), 'next-id')
    assert.strictEqual(context.getTag('_dd.appsec.user.collection_mode'), 'anonymization')
  })
})
