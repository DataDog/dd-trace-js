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
  ['/health', '/health', '/health'],
  ['/users/:id', '/users/42', '/users/{id}'],
  ['/users/:id', '/users/%2Fsecret?query=value', '/users/{id}'],
  ['/photos/:id.:format', '/photos/42.jpg', '/photos/{id+format}'],
  ['/version/:major.:minor.:patch', '/version/1.2.3', '/version/{major+minor+patch}'],
  ['/flights/:from-:to', '/flights/CDG-LHR', '/flights/{from+to}'],
  ['/mixed/user-:id', '/mixed/user-42', '/mixed/{id}'],
  ['/names/:foo+bar', '/names/42', '/names/{foo%2Bbar}'],
  ['/unicode/:café', '/unicode/42', '/unicode/{café}'],
  ['/braces/:{foo}', '/braces/42', '/braces/{%7Bfoo%7D}'],
  ['/colon/:a:b', '/colon/42', '/colon/{a:b}'],
  ['/name-colons/:a::b', '/name-colons/42', '/name-colons/{a::b}'],
  ['/prototype/:__proto__', '/prototype/42', '/prototype/{__proto__}'],
  ['/constructor/:constructor', '/constructor/42', '/constructor/{constructor}'],
  ['/name-star/:file*', '/name-star/42', '/name-star/{file*}'],
  ['/duplicate/:id/:id', '/duplicate/a/b', '/duplicate/{param1}/{id}'],
  ['/shadow/:param1/:id/:id', '/shadow/a/b/c', '/shadow/{param1}/{param2}/{id}'],
  ['/encoded/:a+b/:a%2Bb', '/encoded/a/b', '/encoded/{param1}/{a%2Bb}'],
  ['/unnamed/:', '/unnamed/42', '/unnamed/{param1}'],
  ['/unnamed-collision/:/:param1', '/unnamed-collision/a/b', '/unnamed-collision/{param2}/{param1}'],
  ['/numeric/:id(\\d+)', '/numeric/42', '/numeric/{id}'],
  ['/nested/:id((?:\\d+))', '/nested/42', '/nested/{id}'],
  ['/escaped/:id(\\([a-z]+\\))', '/escaped/(abc)', '/escaped/{id}'],
  ['/classes/:id([()a-z]+)', '/classes/(abc)', '/classes/{id}'],
  ['/suffix/:id(\\d+)*', '/suffix/42*', '/suffix/{id}'],
  ['/files/*', '/files/a/b/c', '/files/{param1}'],
  ['/files/*', '/files/', '/files/{param1}'],
  ['/tail/file-*', '/tail/file-a/b', '/tail/{param1}'],
  ['/collision/:param1/*', '/collision/a/b/c', '/collision/{param1}/{param2}'],
  ['/items/:id?', '/items', undefined],
  ['/items/:id?', '/items/42', undefined],
  ['/optional/:id/:id?', '/optional/a', undefined],
  ['/optional/:id/:id?', '/optional/a/a', undefined],
  ['/partial/:file.:ext?', '/partial', undefined],
  ['/partial/:file.:ext?', '/partial/a.txt', undefined],
  ['/end/:id?/', '/end/', undefined],
  ['/end/:id?/', '/end/42/', undefined],
  ['/literal::name', '/literal:name', '/literal%3Aname'],
  ['/literal::::name', '/literal::name', '/literal%3A%3Aname'],
  ['/prefix:::id', '/prefix:42', '/{id}'],
  ['/braces{literal}', '/braces%7Bliteral%7D', '/braces%7Bliteral%7D'],
  ['/ab(cd)', '/ab(cd)', '/ab%28cd%29'],
  ['/café', '/caf%C3%A9', '/caf%C3%A9'],
  ['/trailing/:id/', '/trailing/42/', '/trailing/{id}/'],
  ['/empty//path', '/empty//path', '/empty/path'],
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
      app.get('/reroute/:id?', (request, reply) => {
        reply.hijack()
        request.raw.url = '/users/42'
        app.routing(request.raw, reply.raw)
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
          request.params = {}
          done()
        },
      }, (request, reply) => reply.send('OK'))
      app.get('/gone/:id', (request, reply) => reply.callNotFound())
      app.get('/throws/:id', () => { throw new Error('application error') })
      app.get('/early/:id', {
        onRequest (request, reply) {
          reply.code(403).send('Forbidden')
        },
      }, () => assert.fail('The early response must bypass the handler'))
      app.register((child, options, done) => {
        child.get('/posts/:id?', (request, reply) => reply.send('OK'))
        child.register((nested, options, done) => {
          nested.get('/members/:member', (request, reply) => reply.send('OK'))
          done()
        }, { prefix: '/groups/:group' })
        done()
      }, { prefix: '/api/:tenant' })

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
      await check('/api/acme/posts', '/api/:tenant/posts/:id?', undefined)
      await check('/api/acme/posts/42', '/api/:tenant/posts/:id?', undefined)
      await check('/api/acme/groups/admin/members/42',
        '/api/:tenant/groups/:group/members/:member', '/api/{tenant}/groups/{group}/members/{member}')
    })

    it('preserves the match when application hooks change params', async () => {
      await check('/mutate/42', '/mutate/:id?', undefined)
      await check('/mutate', '/mutate/:id?', undefined)
    })

    it('normalizes errors and early responses without changing their status', async () => {
      await check('/throws/42', '/throws/:id', '/throws/{id}', 500)
      await check('/early/42', '/early/:id', '/early/{id}', 403)
      await check('/gone/42', '/gone/:id', '/gone/{id}', 404)
    })

    it('normalizes the fallback 404 route when it is present on the span', () => {
      return check('/missing', '/*', '/{param1}', 404)
    })

    it('does not invent a route for a malformed URL rejected by the router', () => {
      return check('/users/%ZZ', undefined, undefined, 400)
    })

    it('omits optional routes across concurrent requests and cache hits', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2
        ? check('/optional/a/a', '/optional/:id/:id?', undefined)
        : check('/optional/a', '/optional/:id/:id?', undefined)))
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

    it('captures the new route when Fastify dispatches the same raw request again', async () => {
      await check('/reroute', '/users/:id', '/users/{id}')
      await check('/reroute/a', '/users/:id', '/users/{id}')
    })

    it('replaces the capture when another Fastify router matches the same declaration', async () => {
      await check('/handoff', '/handoff/:id?', undefined)
      await check('/handoff/42', '/handoff/:id?', undefined)
    })

    it('omits the normalized tag when the final route was overridden', async () => {
      await check('/custom-tag/42', '/custom-route', undefined)
    })

    it('omits stale Fastify branches when an Express router replaces the route', async () => {
      const fastify = require('../../../../versions/fastify@' + version).get()
      const router = require('../../../../versions/express@5').get().Router()
      const mixed = fastify()
      router.get('/users/:id', (req, res) => res.end('OK'))
      router.get('/{:id}', (req, res) => res.end('OK'))
      mixed.addHook('onRequest', (request, reply, done) => router(request.raw, reply.raw, done))
      mixed.get('/*', (request, reply) => reply.send('fallback'))
      mixed.get('/{:id}', (request, reply) => reply.send('fallback'))
      try {
        await mixed.listen({ host: '127.0.0.1', port: 0 })
        const baseURL = 'http://127.0.0.1:' + mixed.server.address().port
        await check('/users/42', '/users/:id', undefined, 200, baseURL)
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
        await check('/loose/42', '/Loose//:id/', '/Loose/{id}/', 200, baseURL)
        await check('/LOOSE///42/', '/Loose//:id/', '/Loose/{id}/', 200, baseURL)
        await check('/optional', '/Optional/:id?/', undefined, 200, baseURL)
        await check('/OPTIONAL/42', '/Optional/:id?/', undefined, 200, baseURL)
        await check('/catch/all', '*', '/{param1}', 200, baseURL)
      } finally {
        await configured.close()
      }
    })
  })
})

withVersions('fastify', 'fastify', '<4', version => {
  describe('legacy Fastify normalized route omission', () => {
    let app, origin

    before(async () => {
      await agent.load(['fastify', 'find-my-way', 'http'], [{ headers }, {}, { client: false, headers }])
      const fastify = require('../../../../versions/fastify@' + version).get()
      app = fastify()
      app.get('/photos/:id.:format', (request, reply) => reply.send('OK'))
      app.get('/literal::name', (request, reply) => reply.send('OK'))
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve())
      }))
      origin = 'http://127.0.0.1:' + app.server.address().port
    })

    beforeEach(() => enableApiSecurity())
    afterEach(() => appsec.disable())
    after(async () => {
      if (app) {
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
          app.close(err => err ? reject(err) : resolve())
        }))
      }
      await agent.close()
    })

    for (const [url, route] of [['/photos/a.jpg', '/photos/:id.:format'], ['/literal:name', '/literal::name']]) {
      it(`omits the tag for ${route}`, async () => {
        const traces = agent.assertSomeTraces(traces => {
          const span = traces.flat().find(span => span.meta['http.request.headers.x-test-request-id'] === url)
          assert.ok(span)
          assert.equal(span.meta['http.route'], route)
          assert.equal(Object.hasOwn(span.meta, tag), false)
        })
        await Promise.all([
          traces,
          http.request(url, { baseURL: origin, headers: { 'x-test-request-id': url } }),
        ])
      })
    }
  })
})
