'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const {
  normalizeRoute: normalizeFastify, normalizeRequest, onRequest,
} = require('../../../src/appsec/api_security/normalized-route/fastify')
const web = require('../../../src/plugins/util/web')
const tracer = require('../../..').init({ plugins: false })

const cases = [
  [undefined, undefined, null],
  ['', undefined, null],
  ['invalid', undefined, null],
  ['/broken/:id(', undefined, null],
  ['/files/*/tail', undefined, null],
  ['/literal/::name?', {}, null],
  ['/odd/::prefix*?', {}, null],
  ['/colon-prefix/::prefix-:id?', {}, '/colon-prefix'],
  ['/colon-prefix/::prefix-:id?', { id: '42' }, '/colon-prefix/%3Aprefix-{id}'],
  ['/:?', {}, '/'],
  ['/:?', { '': '42' }, '/{param1}'],
  ['/items/:id?', undefined, '/items'],
  ['/items/:id?', {}, '/items'],
  ['/items/:id?', { id: '' }, '/items/{id}'],
  ['/items/:id?', { id: '42' }, '/items/{id}'],
  ['/items/:id?', { id: '/' }, '/items/{id}'],
  ['/items/:id?/', {}, '/items/'],
  ['/items/:id?/', { id: '42' }, '/items/{id}/'],
  ['/files/:name.:ext?', {}, '/files'],
  ['/files/:name.:ext?', { name: 'report', ext: 'json' }, '/files/{name}.{ext}'],
  ['/suffix/:name.json?', {}, '/suffix'],
  ['/suffix/:name.json?', { name: '' }, '/suffix/{name}.json'],
  ['/pair/:id-:id?', {}, '/pair'],
  ['/pair/:id-:id?', { id: 'b' }, '/pair/{id_2}-{id}'],
  ['/pair/:id-:id?', { id: '' }, '/pair/{id_2}-{id}'],
  ['/duplicate/:id/:id?', { id: '42' }, null],
  ['/mixed/:id/:id-:other?', { id: 'a' }, '/mixed/{id}'],
  ['/mixed/:id/:id-:other?', { id: 'b', other: '' }, '/mixed/{id_2}/{id}-{other}'],
  ['/files/*', undefined, '/files/'],
  ['/files/*', { '*': '' }, '/files/'],
  ['/files/*', { '*': '///' }, '/files/'],
  ['/files/*', { '*': 'a/b' }, '/files/{param1}'],
  ['/files/file-*', { '*': '' }, '/files/file-'],
  ['/files/file-*', { '*': 'a/b' }, '/files/file-{param1}'],
  ['/:param1/*', { '*': 'a/b' }, '/{param1}/{param2}'],
  ['/:/:param1', {}, '/{param2}/{param1}'],
  ['/names/:a+b/:a_b/:a_b_2', {}, '/names/{a_b_3}/{a_b}/{a_b_2}'],
  ['/names/:a+b/:a_b?', {}, '/names/{a_b}'],
  ['/names/:a+b/:a_b?', { a_b: 'x' }, '/names/{a_b_2}/{a_b}'],
  ['/literal::name', {}, '/literal%3Aname'],
  ['/caf%c3%a9', {}, '/caf%C3%A9'],
]

describe('normalizeRouteFastify', () => {
  for (const [route, params, expected] of cases) {
    it(`${route} with ${JSON.stringify(params)} becomes ${expected}`, () => {
      assert.equal(normalizeFastify(route, params), expected)
    })
  }

  it('keeps optional branches independent across cache hits', () => {
    assert.equal(normalizeFastify('/cached/:id?', { id: '42' }), '/cached/{id}')
    assert.equal(normalizeFastify('/cached/:id?', {}), '/cached')
    assert.equal(normalizeFastify('/cached/:id?', { id: '7' }), '/cached/{id}')
  })
})

describe('Fastify route capture', () => {
  const spans = []
  const server = { version: '5.0.0' }

  afterEach(() => {
    for (const span of spans.splice(0)) span.finish()
  })

  /** @param {string} route */
  function routedRequest (route) {
    const req = { method: 'GET', url: '/', headers: { host: 'localhost' } }
    const config = web.normalizeConfig({})
    spans.push(web.startSpan(tracer, config, req, {}, 'test.request'))
    web.setRoute(req, route)
    return req
  }

  /**
   * @param {object} req
   * @param {string | undefined} route
   */
  function captureRoute (req, route) {
    onRequest({ req, request: { server }, routeOptions: { url: route } })
  }

  for (const [version, supported, routeOptions] of [
    ['3.29.5', false], ['4.0.0', true], ['5.0.0', true, { url: '/items/:id?' }], ['6.0.0', false],
  ]) {
    it(`decides support in the subscriber for Fastify ${version}`, () => {
      const route = '/items/:id?'
      const req = routedRequest(route)
      const request = {
        server: { version },
        routerPath: routeOptions === undefined ? route : undefined,
        params: { id: '42' },
      }
      onRequest({ req, request, routeOptions })
      assert.equal(normalizeRequest(req, route), supported ? '/items/{id}' : null)
    })
  }

  it('does not capture a request without its Fastify server', () => {
    const req = routedRequest('/items/:id')
    onRequest({ req, request: {}, routeOptions: { url: '/items/:id' } })
    assert.equal(normalizeRequest(req, '/items/:id'), null)
  })

  it('captures the normalized route and invalidates it after another router sets a route', () => {
    const req = routedRequest('/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), null)
    captureRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), '/items/{id}')
    web.setRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), null)
    captureRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), '/items/{id}')
  })

  for (const route of [undefined, '/other/:id']) {
    it(`omits an unavailable or mismatched public declaration: ${route}`, () => {
      const req = routedRequest('/items/:id')
      captureRoute(req, route)
      assert.equal(normalizeRequest(req, '/items/:id'), null)
    })
  }

  for (const [prefix, mode, expected] of [
    ['/api/:tenant', 'both', '/api/{tenant}/'],
    ['/api/:tenant', 'slash', null],
    ['/api/:tenant', 'no-slash', null],
    ['/other', 'both', null],
    [undefined, 'both', null],
  ]) {
    it(`accepts only a prefixed root alias: prefix=${prefix}, prefixTrailingSlash=${mode}`, () => {
      const req = routedRequest('/api/:tenant/')
      onRequest({
        req,
        request: { server: { ...server, prefix } },
        routeOptions: { url: '/api/:tenant', prefixTrailingSlash: mode },
      })
      assert.equal(normalizeRequest(req, '/api/:tenant/'), expected)
      assert.equal(normalizeRequest(req, '/api/:tenant'), null)
      web.setRoute(req, '/api/:tenant/')
      assert.equal(normalizeRequest(req, '/api/:tenant/'), null)
    })
  }

  it('omits the tag when the final route disagrees with the capture', () => {
    const req = routedRequest('/items/:id')
    captureRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/override'), null)
    web.setRoute(req, '/items/:id/nested')
    captureRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), null)
  })

  it('ignores a request without a web context', () => {
    const req = {}
    captureRoute(req, '/items/:id')
    assert.equal(normalizeRequest(req, '/items/:id'), null)
  })
})
