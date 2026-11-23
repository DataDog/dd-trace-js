'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { describe, it, before, after } = require('mocha')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { withVersions } = require('../setup/mocha')
const { getConfigFresh } = require('../helpers/config')
const HttpRequest = require('../setup/helpers/http-client')

const ok = (req, res) => res.end('OK')

// The normalized route is supported on Express 5 only.
withVersions('express', 'express', '>=5', version => {
  describe('Normalized HTTP route tag (_dd.appsec.normalized_route)', () => {
    const servers = []
    const requests = {}

    function listen (key, app) {
      return new Promise(resolve => {
        const server = app.listen(0, () => {
          const { port } = /** @type {import('net').AddressInfo} */ (server.address())
          requests[key] = HttpRequest.create({ baseURL: `http://localhost:${port}` })
          resolve()
        })
        servers.push(server)
      })
    }

    // Optional groups in a mount prefix, a mounted root route and a route array.
    function mountTenantRouters (express, app, routerOptions) {
      const tenantRouter = express.Router({ ...routerOptions, mergeParams: true })
      tenantRouter.get('/users/:id', ok)
      tenantRouter.get('/', ok)
      app.use('/api{/preview}{/:tenant}/v1', tenantRouter)
      const aliasRouter = express.Router({ ...routerOptions, mergeParams: true })
      aliasRouter.get(['/api{/preview}{/:tenant}/v1/users/:id', '/users/:id'], ok)
      app.use('/outer/api{/preview}{/:tenant}/v1', aliasRouter)
    }

    before(() => {
      // Load 'router' alongside 'express' so Express 5 populates context.paths via apm:router:middleware:enter
      return agent.load(['express', 'http', 'router'], [{}, { client: false }, {}])
    })

    before(() => {
      const express = require(`../../../../versions/express@${version}`).get()

      // Registered while AppSec is off, so its Router's options are unknown.
      const unrecordedApp = express()
      unrecordedApp.set('case sensitive routing', true)
      unrecordedApp.get('/p{A}{a}', ok)

      // AppSec is enabled before routes are registered, as at tracer init: it records each Router's options.
      enableAppsec(true)

      const app = express()
      app.get('/users/:id', ok)
      app.get('/health', ok)
      app.get('/items{/:id}', ok)
      app.get('/posts{/draft}', ok)
      app.get('/tree{/:branch{/:leaf}}', ok)
      app.get('/files/:name.json', ok)
      app.get('/files/*splat', ok)
      app.get('/photos/:id.:format', ok)
      app.get('/u/:"user-id"/:user_id', ok)
      app.get('/a/*mid/b', ok)
      app.get('/drafts{/edit}/', ok)
      const router = express.Router()
      router.get('/posts/:postId', ok)
      router.get('/pages{/draft}', ok)
      app.use('/api', router)
      // A Router keeps its own options; it does not inherit the app's.
      const sensitiveRouter = express.Router({ caseSensitive: true })
      sensitiveRouter.get('/p{A}{a}', ok)
      app.use('/s', sensitiveRouter)
      mountTenantRouters(express, app, { caseSensitive: true })
      const scopeRouter = express.Router({ caseSensitive: true, mergeParams: true })
      scopeRouter.get('/users{/V1/users}/:id', ok)
      app.use('/w/*scope/v1', scopeRouter)
      const partsRouter = express.Router({ mergeParams: true })
      partsRouter.get('/parts{/:id}', ok)
      app.use('/t/:tenant', partsRouter)
      const orgRouter = express.Router()
      orgRouter.get('/users/:userId', ok)
      app.use('/orgs{/:orgId}', orgRouter)
      const upperRouter = express.Router({ caseSensitive: true })
      upperRouter.get('/p{A}{a}', ok)
      app.use('/API', upperRouter)
      const rootRouter = express.Router()
      rootRouter.get('', ok)
      app.use('/root{/:x}', rootRouter)
      // Answered by an app-level error handler, after Express restored req.url and req.baseUrl.
      const failingRouter = express.Router()
      failingRouter.get('/boom{/:id}', () => { throw new Error('boom') })
      app.use('/e', failingRouter)
      app.use((err, req, res, next) => res.status(500).end())

      // Apps with routing settings, each with a direct route and a default Router mounted at /r.
      const settingApps = {
        sensitive: ['case sensitive routing', '/p{A}{a}'],
        strict: ['strict routing', '/posts{/draft}/'],
      }
      const listening = [listen('default', app), listen('unrecorded', unrecordedApp)]
      for (const [key, [setting, route]] of Object.entries(settingApps)) {
        const settingApp = express()
        settingApp.set(setting, true)
        settingApp.get(route, ok)
        const settingRouter = express.Router()
        settingRouter.get(route, ok)
        settingApp.use('/r', settingRouter)
        if (key === 'sensitive') mountTenantRouters(express, settingApp, {})
        listening.push(listen(key, settingApp))
      }
      return Promise.all(listening)
    })

    after(() => {
      appsec.disable()
      for (const server of servers) server.close()
      return agent.close({ ritmReset: false })
    })

    function enableAppsec (apiSecurityEnabled) {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: { enabled: apiSecurityEnabled },
        },
      }))
    }

    const cases = [
      ['default', '/users/42', '/users/{id}'],
      ['default', '/health', '/health'],
      ['default', '/api/posts/99', '/api/posts/{postId}'],
      ['default', '/items/7', '/items/{id}'],
      ['default', '/items', '/items'],
      ['default', '/posts/draft', '/posts/draft'],
      ['default', '/posts', '/posts'],
      ['default', '/tree/main/leaf1', '/tree/{branch}/{leaf}'],
      ['default', '/tree/main', '/tree/{branch}'],
      ['default', '/files/report.json', '/files/{name}.json'],
      ['default', '/files/a/b/c.txt', '/files/{splat}'],
      ['default', '/photos/1.jpg', '/photos/{id}.{format}'],
      ['default', '/u/1/2', '/u/{user_id_2}/{user_id}'],
      ['default', '/a/x/y/b', '/a/{mid}/b'],
      // Non-strict routing matches the route without its trailing slash, as Express does.
      ['default', '/drafts/edit', '/drafts/edit/'],
      // A static mount prefix keeps per-request resolution of the leaf's optional groups.
      ['default', '/api/pages/draft', '/api/pages/draft'],
      ['default', '/api/pages', '/api/pages'],
      // Matched with the options of the Router that owns the served route.
      ['default', '/s/pa', '/s/pa'],
      ['sensitive', '/pa', '/pa'],
      ['sensitive', '/r/pa', '/r/pA'],
      ['strict', '/posts/draft/', '/posts/draft/'],
      ['strict', '/r/posts/draft', '/r/posts/draft/'],
      // A mount prefix matches with the app Router's options: the case-insensitive app takes the
      // static {/preview} group, the case-sensitive one binds 'PREVIEW' as the tenant.
      ['default', '/api/PREVIEW/v1/users/42', '/api/preview/v1/users/{id}'],
      ['default', '/api/acme/v1/users/42', '/api/{tenant}/v1/users/{id}'],
      ['default', '/api/PREVIEW/v1', '/api/preview/v1'],
      // A route array can't be split where it matched: presence comes from req.params.
      ['default', '/outer/api/PREVIEW/v1/users/42', '/outer/api/v1/users/{id}'],
      ['default', '/w/foo/v1/users/V1/users/42', '/w/{scope}/v1/users/{id}'],
      // A decoded '%2F' is an ordinary param value, not an empty one.
      ['default', '/t/acme/parts/%2F', '/t/{tenant}/parts/{id}'],
      // A mount's params are matched even when req.params (mergeParams=false) lacks them.
      ['default', '/orgs/acme/users/42', '/orgs/{orgId}/users/{userId}'],
      // The served route matches the rest of the URL with its own options, whatever the mount's case.
      ['default', '/api/pa', '/API/pa'],
      // An empty served route ('') answers the mount root.
      ['default', '/root/1', '/root/{x}'],
      ['default', '/root', '/root'],
      // Unknown Router options: presence comes from req.params, not a guessed case-insensitive match.
      ['unrecorded', '/pa', '/p'],
      ['sensitive', '/api/PREVIEW/v1/users/42', '/api/{tenant}/v1/users/{id}'],
      ['sensitive', '/api/PREVIEW/v1', '/api/{tenant}/v1'],
      ['sensitive', '/outer/api/PREVIEW/v1/users/42', '/outer/api/{tenant}/v1/users/{id}'],
    ]
    for (const [key, url, expected] of cases) {
      it(`sets normalized route ${expected} for ${url} on the ${key} app`, async () => {
        await requests[key].get(url)

        await agent.assertSomeTraces((traces) => {
          assert.equal(traces[0][0].meta['_dd.appsec.normalized_route'], expected)
        })
      })
    }

    it('sets normalized route /e/boom/{id} when an error handler outside the Router answers', async () => {
      await requests.default.get('/e/boom/1', { validateStatus: null })

      await agent.assertSomeTraces((traces) => {
        assert.equal(traces[0][0].meta['_dd.appsec.normalized_route'], '/e/boom/{id}')
      })
    })

    it('does NOT set normalized route when API Security is disabled', async () => {
      appsec.disable()
      enableAppsec(false)
      await requests.default.get('/users/42')

      await agent.assertSomeTraces((traces) => {
        assert.ok(!Object.hasOwn(traces[0][0].meta, '_dd.appsec.normalized_route'))
      })
    })
  })
})
