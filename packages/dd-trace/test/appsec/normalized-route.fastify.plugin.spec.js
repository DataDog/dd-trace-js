'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const appsec = require('../../src/appsec')
const web = require('../../src/plugins/util/web')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const http = require('../setup/helpers/http-client')
const { withVersions } = require('../setup/mocha')

const tag = '_dd.appsec.normalized_route'
const headers = ['x-test-request-id']

/** @type {Array<[string, string, string | undefined]>} */
const cases = [
  ['/', '/', '/'],
  ['/users/:id', '/users/42', '/users/{id}'],
  ['/users/:id', '/users/%2Fsecret?query=value', '/users/{id}'],
  ['/photos/:id.:format', '/photos/42.jpg', '/photos/{id}.{format}'],
  ['/flights/:from-:to', '/flights/CDG-LHR', '/flights/{from}-{to}'],
  ['/mixed/user-:id', '/mixed/user-42', '/mixed/user-{id}'],
  ['/colon/:a:b', '/colon/42', '/colon/{a_b}'],
  ['/name-star/:file*', '/name-star/42', '/name-star/{file_}'],
  ['/unnamed-collision/:/:param1', '/unnamed-collision/a/b', '/unnamed-collision/{param2}/{param1}'],
  ['/nested/:id((?:\\d+))', '/nested/42', '/nested/{id}'],
  ['/escaped/:id(\\([a-z]+\\))', '/escaped/(abc)', '/escaped/{id}'],
  ['/suffix/:id(\\d+)*', '/suffix/42*', '/suffix/{id}%2A'],
  ['/files/*', '/files/a/b/c', '/files/{param1}'],
  ['/files/*', '/files/', '/files/'],
  ['/optional-collision/:a+b/:a_b?', '/optional-collision/x/y', '/optional-collision/{a_b_2}/{a_b}'],
  ['/optional-collision/:a+b/:a_b?', '/optional-collision/x', '/optional-collision/{a_b}'],
  ['/items/:id?', '/items', '/items'],
  ['/items/:id?', '/items/', '/items/{id}'],
  ['/items/:id?', '/items/42', '/items/{id}'],
  ['/optional/:id/:id?', '/optional/a/b', undefined],
  ['/pair/:id-:id?', '/pair/a-b', '/pair/{id_2}-{id}'],
  ['/pair/:id-:id?', '/pair/-', '/pair/{id_2}-{id}'],
  ['/mixed-optional/:id/:id-:other?', '/mixed-optional/a/b-', '/mixed-optional/{id_2}/{id}-{other}'],
  ['/optional-suffix/:name.json?', '/optional-suffix/.json', '/optional-suffix/{name}.json'],
  ['/partial/:file.:ext?', '/partial', '/partial'],
  ['/partial/:file.:ext?', '/partial/a.txt', '/partial/{file}.{ext}'],
  ['/end/:id?/', '/end/', '/end/'],
  ['/end/:id?/', '/end/42/', '/end/{id}/'],
  ['/static-optional/::name?', '/static-optional/:name', undefined],
  ['/wildcard-optional/::prefix*?', '/wildcard-optional/:prefixabc', undefined],
  ['/colon-prefix/::prefix-:id?', '/colon-prefix/:prefix-42', '/colon-prefix/%3Aprefix-{id}'],
  ['/prefix:::id', '/prefix:42', '/prefix%3A{id}'],
]

/** @param {boolean} [enabled] */
function enableApiSecurity (enabled = true) {
  appsec.enable(getConfigFresh({
    appsec: {
      enabled: true,
      rules: path.join(__dirname, 'api_security_rules.json'),
      apiSecurity: { enabled },
    },
  }))
}

withVersions('fastify', 'fastify', '>=4 <6', version => {
  describe('normalized HTTP routes', () => {
    let app, forwarded, origin
    let requestId = 0

    before(async () => {
      await agent.load(['fastify', 'find-my-way', 'http', 'express', 'router'], [
        { headers }, {}, { client: false, headers }, {}, {},
      ])
      const fastify = require('../../../../versions/fastify@' + version).get()
      app = fastify()
      const registered = new Set()
      for (const [route] of cases) {
        if (registered.has(route)) continue
        registered.add(route)
        app.get(route, (request, reply) => reply.send('OK'))
      }
      app.get('/custom-tag/:id', (request, reply) => {
        web.root(request.raw).setTag('http.route', '/custom-route')
        return reply.send('OK')
      })
      forwarded = fastify()
      forwarded.get('/handoff/:id?', (request, reply) => reply.send('OK'))
      await forwarded.ready()
      app.get('/handoff/:id?', (request, reply) => {
        reply.hijack()
        request.raw.url = request.params.id === undefined ? '/handoff/42' : '/handoff'
        forwarded.routing(request.raw, reply.raw)
      })
      app.get('/mutate/:id?', {
        onRequest (request, reply, done) {
          request.params.id = undefined
          request.params = {}
          request.raw.url = '/changed'
          done()
        },
      }, (request, reply) => reply.send('OK'))
      app.get('/gone/:id', (request, reply) => reply.callNotFound())
      app.get('/early/:id', {
        onRequest (request, reply) {
          reply.code(403).send('Forbidden')
        },
      }, () => assert.fail('The early response must bypass the handler'))
      app.register((child, options, done) => {
        child.register((nested, options, done) => {
          nested.get('/members/:member', (request, reply) => reply.send('OK'))
          done()
        }, { prefix: '/groups/:group' })
        done()
      }, { prefix: '/api/:tenant' })

      for (const mode of [undefined, 'both', 'slash', 'no-slash']) {
        app.register((child, options, done) => {
          child.get('/', { prefixTrailingSlash: mode }, (request, reply) => reply.send('OK'))
          done()
        }, { prefix: `/prefix-${mode ?? 'default'}/:tenant` })
      }

      await app.listen({ host: '127.0.0.1', port: 0 })
      origin = 'http://127.0.0.1:' + app.server.address().port
    })

    beforeEach(() => enableApiSecurity())
    afterEach(() => appsec.disable())
    after(async () => {
      await app?.close()
      await forwarded?.close()
      await agent.close()
    })

    /**
     * Match each exported span to its request, including concurrent requests
     * whose route and URL path can otherwise be identical.
     * @param {string} url
     * @param {string | undefined} route
     * @param {string | undefined} normalized
     * @param {number} [status]
     * @param {string} [baseURL]
     */
    async function check (url, route, normalized, status = 200, baseURL = origin) {
      const id = String(++requestId)
      const traces = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(span => span.meta['http.request.headers.x-test-request-id'] === id)
        assert.ok(span, 'Missing span for ' + url)
        assert.equal(span.meta['http.route'], route)
        assert.equal(span.meta[tag], normalized)
        assert.equal(span.meta['http.status_code'], String(status))
        if (normalized === undefined) assert.equal(Object.hasOwn(span.meta, tag), false)
      })
      const [, response] = await Promise.all([
        traces,
        http.request(url, {
          method: 'GET',
          baseURL,
          headers: { 'x-test-request-id': id },
          validateStatus: () => true,
        }),
      ])
      assert.equal(response.status, status)
    }

    for (const [route, url, normalized] of cases) {
      it(route + ' on ' + url + ' becomes ' + normalized, () => check(url, route, normalized))
    }

    it('includes nested router prefixes and their parameters', async () => {
      await check('/api/acme/groups/admin/members/42',
        '/api/:tenant/groups/:group/members/:member', '/api/{tenant}/groups/{group}/members/{member}')
    })

    for (const mode of [undefined, 'both', 'slash', 'no-slash']) {
      it(`normalizes prefixed root routes with prefixTrailingSlash=${mode ?? 'default'}`, async () => {
        const prefix = `/prefix-${mode ?? 'default'}`
        if (mode !== 'slash') await check(prefix + '/acme', prefix + '/:tenant', prefix + '/{tenant}')
        if (mode !== 'no-slash') await check(prefix + '/acme/', prefix + '/:tenant/', prefix + '/{tenant}/')
      })
    }

    it('preserves the match when application hooks change params', async () => {
      await check('/mutate/42', '/mutate/:id?', '/mutate/{id}')
      await check('/mutate', '/mutate/:id?', '/mutate')
    })

    it('normalizes early responses and matched routes that return 404', async () => {
      await check('/early/42', '/early/:id', '/early/{id}', 403)
      await check('/gone/42', '/gone/:id', '/gone/{id}', 404)
    })

    it('omits the normalized route for an unmatched request', () => check('/.env', '/*', undefined, 404))

    it('does not invent a route for a malformed URL rejected by the router', () => {
      return check('/users/%ZZ', undefined, undefined, 400)
    })

    it('resolves optional routes across concurrent requests and cache hits', async () => {
      await Promise.all([
        check('/items/42', '/items/:id?', '/items/{id}'),
        check('/items', '/items/:id?', '/items'),
      ])
    })

    it('stops emitting the tag when API Security is disabled and resumes after re-enabling', async () => {
      await check('/users/42', '/users/:id', '/users/{id}')
      appsec.disable()
      enableApiSecurity(false)
      await check('/users/42', '/users/:id', undefined)
      appsec.disable()
      enableApiSecurity()
      await check('/users/42', '/users/:id', '/users/{id}')
    })

    it('does not emit the tag when AppSec is disabled', async () => {
      appsec.disable()
      await check('/users/42', '/users/:id', undefined)
    })

    it('replaces the capture when another Fastify router matches the same declaration', async () => {
      await check('/handoff', '/handoff/:id?', '/handoff/{id}')
      await check('/handoff/42', '/handoff/:id?', '/handoff')
    })

    it('omits the normalized tag when the final route was overridden', async () => {
      await check('/custom-tag/42', '/custom-route', undefined)
    })

    it('omits stale Fastify branches when an Express router replaces the route', async () => {
      const fastify = require('../../../../versions/fastify@' + version).get()
      const router = require('../../../../versions/express@5').get().Router()
      const mixed = fastify()
      router.get('/{:id}', (req, res) => res.end('OK'))
      mixed.addHook('onRequest', (request, reply, done) => router(request.raw, reply.raw, done))
      mixed.get('/{:id}', (request, reply) => reply.send('fallback'))
      try {
        await mixed.listen({ host: '127.0.0.1', port: 0 })
        const baseURL = 'http://127.0.0.1:' + mixed.server.address().port
        // Equal declarations still use different grammars: Fastify calls this parameter "id}".
        await check('/{abc', '/{:id}', undefined, 200, baseURL)
      } finally {
        await mixed.close()
      }
    })

    it('uses declarations despite case, duplicate-slash and trailing-slash router options', async () => {
      const module = require('../../../../versions/fastify@' + version)
      const routerOptions = { caseSensitive: false, ignoreDuplicateSlashes: true, ignoreTrailingSlash: true }
      const fastify = module.get()
      const configured = fastify(module.version().startsWith('5.') ? { routerOptions } : routerOptions)
      configured.get('/Loose//:id/', (request, reply) => reply.send('OK'))
      configured.get('/Optional/:id?/', (request, reply) => reply.send('OK'))
      configured.get('*', (request, reply) => reply.send('OK'))
      try {
        await configured.listen({ host: '127.0.0.1', port: 0 })
        const baseURL = 'http://127.0.0.1:' + configured.server.address().port
        await check('/LOOSE///42/', '/Loose//:id/', '/Loose/{id}/', 200, baseURL)
        await check('/optional', '/Optional/:id?/', '/Optional/', 200, baseURL)
        await check('/OPTIONAL/42', '/Optional/:id?/', '/Optional/{id}/', 200, baseURL)
        await check('/catch/all', '*', '/{param1}', 200, baseURL)
      } finally {
        await configured.close()
      }
    })
  })
})
