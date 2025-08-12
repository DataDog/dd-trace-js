'use strict'

const Axios = require('axios')
const { assert } = require('chai')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { withVersions } = require('../setup/mocha')

function assertFingerprintInTraces (traces) {
  const span = traces[0][0]
  assert.property(span.meta, '_dd.appsec.fp.http.header')
  assert.equal(span.meta['_dd.appsec.fp.http.header'], 'hdr-0110000110-74c2908f-5-e58aa9dd')
  assert.property(span.meta, '_dd.appsec.fp.http.network')
  assert.equal(span.meta['_dd.appsec.fp.http.network'], 'net-0-0000000000')
  assert.property(span.meta, '_dd.appsec.fp.http.endpoint')
  assert.equal(span.meta['_dd.appsec.fp.http.endpoint'], 'http-post-7e93fba0--')
}

withVersions('passport-http', 'passport-http', version => {
  describe('Attacker fingerprinting', () => {
    let port, server, axios

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before(() => {
      appsec.enable(new Config({
        appsec: true
      }))
    })

    before((done) => {
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
              username
            })
          } else {
            done(null, false)
          }
        }
      ))

      app.post('/login', passport.authenticate('basic', { session: false }), function (req, res) {
        res.end()
      })

      server = app.listen(port, () => {
        port = server.address().port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`,
          headers: {
            'User-Agent': 'test-user-agent'
          }
        })
        done()
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    after(() => {
      appsec.disable()
    })

    it('should report http fingerprints on login fail', async () => {
      try {
        await axios.post(
          `http://localhost:${port}/login`, {}, {
            auth: {
              username: 'fail',
              password: '1234'
            }
          }
        )
      } catch (e) {}

      await agent.assertSomeTraces(assertFingerprintInTraces)
    })

    it('should report http fingerprints on login successful', async () => {
      await axios.post(
        `http://localhost:${port}/login`, {}, {
          auth: {
            username: 'success',
            password: '1234'
          }
        }
      )

      await agent.assertSomeTraces(assertFingerprintInTraces)
    })
  })
})
