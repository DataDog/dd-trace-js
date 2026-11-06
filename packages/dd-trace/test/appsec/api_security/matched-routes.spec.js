'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { onRequest, getMatchedRoute } = require('../../../src/appsec/api_security/normalized-route/matched-routes')
const web = require('../../../src/plugins/util/web')

describe('Fastify route capture', () => {
  it('captures the declaration and invalidates it after another router sets a route', () => {
    const req = {}
    web.patch(req)
    web.setRoute(req, '/items/:id')
    onRequest({ req, routeOptions: { url: '/items/:id' } })
    assert.equal(getMatchedRoute(web.getContext(req).paths), '/items/:id')
    web.setRoute(req, '/items/:id')
    assert.equal(getMatchedRoute(web.getContext(req).paths), undefined)
    onRequest({ req, routeOptions: { url: '/items/:id' } })
    assert.equal(getMatchedRoute(web.getContext(req).paths), '/items/:id')
  })

  it('keeps captures independent for different requests', () => {
    const first = {}
    const second = {}
    web.patch(first)
    web.patch(second)
    web.setRoute(first, '/first/:id')
    web.setRoute(second, '/second/:id')
    onRequest({ req: first, routeOptions: { url: '/first/:id' } })
    onRequest({ req: second, routeOptions: { url: '/second/:id' } })
    assert.equal(getMatchedRoute(web.getContext(first).paths), '/first/:id')
    assert.equal(getMatchedRoute(web.getContext(second).paths), '/second/:id')
  })

  for (const route of [undefined, '/other/:id']) {
    it(`omits an unavailable or mismatched public declaration: ${route}`, () => {
      const req = {}
      web.patch(req)
      web.setRoute(req, '/items/:id')
      onRequest({ req, routeOptions: route === undefined ? undefined : { url: route } })
      assert.equal(getMatchedRoute(web.getContext(req).paths), undefined)
    })
  }

  it('ignores a request without a web context', () => {
    onRequest({ req: {} })
  })
})
