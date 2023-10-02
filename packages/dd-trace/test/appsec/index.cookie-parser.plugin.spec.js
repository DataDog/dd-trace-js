'use strict'

const { assert } = require('chai')
const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')

withVersions('cookie-parser', 'cookie-parser', version => {
  describe('Suspicious request blocking - cookie-parser', () => {
    let port, server, requestCookie

    before(() => {
      return agent.load(['express', 'cookie-parser', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()
      const cookieParser = require(`../../../../versions/cookie-parser@${version}`).get()

      const app = express()
      app.use(cookieParser())
      app.post('/', (req, res) => {
        requestCookie()
        res.end('DONE')
      })

      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
      })
    })

    beforeEach(async () => {
      requestCookie = sinon.stub()
      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'cookie-parser-rules.json') } }))
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not block the request without an attack', async () => {
      const res = await axios.post(`http://localhost:${port}/`, {})

      sinon.assert.calledOnce(requestCookie)
      assert.strictEqual(res.data, 'DONE')
    })

    it('should block the request when attack is detected', async () => {
      try {
        await axios.post(`http://localhost:${port}/`, {}, {
          headers: {
            Cookie: 'key=testattack'
          }
        })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
        sinon.assert.notCalled(requestCookie)
      }
    })
  })
})
