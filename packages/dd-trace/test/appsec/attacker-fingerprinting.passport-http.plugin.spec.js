'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { inspect } = require('node:util')

const Axios = require('axios')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const { withVersions } = require('../setup/mocha')

function assertFingerprintInTraces (traces) {
  const span = traces[0][0]
  assert.ok(Object.hasOwn(span.meta, '_dd.appsec.fp.http.header'), `Available keys: ${inspect(Object.keys(span.meta))}`)
  assert.strictEqual(span.meta['_dd.appsec.fp.http.header'], 'hdr-0110000110-74c2908f-5-e58aa9dd')
  assert.ok(
    Object.hasOwn(span.meta, '_dd.appsec.fp.http.network'),
    `Available keys: ${inspect(Object.keys(span.meta))}`
  )
  assert.strictEqual(span.meta['_dd.appsec.fp.http.network'], 'net-0-0000000000')
  assert.ok(
    Object.hasOwn(span.meta, '_dd.appsec.fp.http.endpoint'),
    `Available keys: ${inspect(Object.keys(span.meta))}`
  )
  assert.strictEqual(span.meta['_dd.appsec.fp.http.endpoint'], 'http-post-7e93fba0--')
}

withVersions('passport-http', 'passport-http', version => {
  describe('Attacker fingerprinting', () => {
    let port, server, axios

    before(async () => {
      await agent.load(['express', 'http'], { client: false })
      appsec.enable(getConfigFresh({
        appsec: true,
      }))
      const express = require('../../../../versions/express').get()
      const bodyParser = require('../../../../versions/body-parser').get()
      const passport = require('../../../../versions/passport').get()
      const { BasicStrategy } = require(`../../../../versions/passport-http@${version}`).get()

      const app = express()
      app.use(bodyParser.json())
      app.use(passport.initialize())

      passport.use(new BasicStrategy(
        function verify (username, password, done) {
          if (username === 'success') {
            done(null, {
              id: 1234,
              username,
            })
          } else {
            done(null, false)
          }
        }
      ))

      app.post('/login', passport.authenticate('basic', { session: false }), function (req, res) {
        res.end()
      })

      server = app.listen(port)
      await once(server, 'listening')
      port = (/** @type {import('net').AddressInfo} */ (server.address())).port
      axios = Axios.create({
        baseURL: `http://localhost:${port}`,
        headers: {
          'User-Agent': 'test-user-agent',
        },
      })
    })

    after(async () => {
      try {
        server?.close()
        await agent.close()
      } finally {
        appsec.disable()
      }
    })

    it('should report http fingerprints on login fail', async () => {
      try {
        await axios.post(
          `http://localhost:${port}/login`, {}, {
            auth: {
              username: 'fail',
              password: '1234',
            },
          }
        )
      } catch {}

      await agent.assertSomeTraces(assertFingerprintInTraces)
    })

    it('should report http fingerprints on login successful', async () => {
      await axios.post(
        `http://localhost:${port}/login`, {}, {
          auth: {
            username: 'success',
            password: '1234',
          },
        }
      )

      await agent.assertSomeTraces(assertFingerprintInTraces)
    })
  })
})
