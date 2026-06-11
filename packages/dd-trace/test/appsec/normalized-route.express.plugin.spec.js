'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const Axios = require('axios')
const semver = require('semver')
const { describe, it, before, afterEach, after } = require('mocha')

const { NODE_MAJOR } = require('../../../../version')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { withVersions } = require('../setup/mocha')
const { getConfigFresh } = require('../helpers/config')

withVersions('express', 'express', version => {
  if (semver.intersects(version, '<=4.10.5') && NODE_MAJOR >= 24) {
    describe.skip(`refusing to run tests as express@${version} is incompatible with Node.js ${NODE_MAJOR}`)
    return
  }

  describe('Normalized HTTP route tag (_dd.appsec.normalized_route)', () => {
    const isExpress4 = semver.intersects(version, '<5.0.0')
    let server, axios

    before(() => {
      // Load 'router' alongside 'express' so Express 5 populates context.paths via apm:router:middleware:enter
      return agent.load(['express', 'http', 'router'], [{ client: false }, {}, {}])
    })

    before((done) => {
      const express = require(`../../../../versions/express@${version}`).get()
      const app = express()

      app.get('/users/:id', (req, res) => res.end('OK'))
      app.get('/health', (req, res) => res.end('OK'))

      // Optional param: Express 4 uses :id?, Express 5 uses {/:id}
      if (isExpress4) {
        app.get('/items/:id?', (req, res) => res.end('OK'))
      } else {
        // Express 5: {/:id} optional segment — our normalizer returns null (omit-rather-than-guess)
        app.get('/items{/:id}', (req, res) => res.end('OK'))
      }

      // Multi-param segment in one URL segment
      app.get('/photos/:id.:format', (req, res) => res.end('OK'))

      // Sub-router with mount path
      const router = express.Router()
      router.get('/posts/:postId', (req, res) => res.end('OK'))
      app.use('/api', router)

      // Catch-all: unnamed in Express 4, named in Express 5
      if (isExpress4) {
        app.get('/files/*', (req, res) => res.end('OK'))
      } else {
        app.get('/files/*splat', (req, res) => res.end('OK'))
      }

      server = app.listen(0, () => {
        const port = /** @type {import('net').AddressInfo} */ (server.address()).port
        axios = Axios.create({ baseURL: `http://localhost:${port}` })
        done()
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    afterEach(() => {
      appsec.disable()
    })

    function enableAppsecWithApiSecurity () {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: { enabled: true },
        },
      }))
    }

    it('sets normalized route for a simple named param', async () => {
      enableAppsecWithApiSecurity()
      await axios.get('/users/42')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.meta['_dd.appsec.normalized_route'], '/users/{id}')
      })
    })

    it('sets normalized route for a static route', async () => {
      enableAppsecWithApiSecurity()
      await axios.get('/health')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.meta['_dd.appsec.normalized_route'], '/health')
      })
    })

    it('sets normalized route for sub-router with mount prefix', async () => {
      enableAppsecWithApiSecurity()
      await axios.get('/api/posts/99')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.meta['_dd.appsec.normalized_route'], '/api/posts/{postId}')
      })
    })

    it('sets normalized route for multi-param segment', async () => {
      enableAppsecWithApiSecurity()
      await axios.get('/photos/1.jpg')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.equal(span.meta['_dd.appsec.normalized_route'], '/photos/{id+format}')
      })
    })

    it('sets normalized route for catch-all wildcard', async () => {
      enableAppsecWithApiSecurity()
      await axios.get('/files/a/b/c.txt')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        const expected = isExpress4 ? '/files/{param1}' : '/files/{splat}'
        assert.equal(span.meta['_dd.appsec.normalized_route'], expected)
      })
    })

    if (isExpress4) {
      it('sets normalized route including optional param when present (Express 4)', async () => {
        enableAppsecWithApiSecurity()
        await axios.get('/items/7')

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.normalized_route'], '/items/{id}')
        })
      })

      it('sets normalized route excluding optional param when absent (Express 4)', async () => {
        enableAppsecWithApiSecurity()
        await axios.get('/items')

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.normalized_route'], '/items')
        })
      })
    } else {
      it('sets normalized route for Express 5 {/:id} optional-segment — param present', async () => {
        enableAppsecWithApiSecurity()
        await axios.get('/items/7')

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.normalized_route'], '/items/{id}')
        })
      })

      it('sets normalized route for Express 5 {/:id} optional-segment — param absent', async () => {
        enableAppsecWithApiSecurity()
        await axios.get('/items')

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.normalized_route'], '/items')
        })
      })
    }

    it('does NOT set normalized route when API Security is disabled', async () => {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: { enabled: false },
        },
      }))
      await axios.get('/users/42')

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.ok(!Object.hasOwn(span.meta, '_dd.appsec.normalized_route'))
      })
    })
  })
})
