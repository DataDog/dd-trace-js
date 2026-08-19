'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const path = require('node:path')

const axios = require('axios')
const sinon = require('sinon')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const { withVersions } = require('../setup/mocha')
const { blockedTemplateJson: json, setTestBlockingTemplates } = require('./utils')

withVersions('cookie-parser', 'cookie-parser', version => {
  describe('Suspicious request blocking - cookie-parser', () => {
    let port, server, requestCookie

    before(async () => {
      await agent.load(['express', 'cookie-parser', 'http'], { client: false })
      const express = require('../../../../versions/express').get()
      const cookieParser = require(`../../../../versions/cookie-parser@${version}`).get()

      const app = express()
      app.use(cookieParser())
      app.post('/', (req, res) => {
        requestCookie()
        res.end('DONE')
      })

      server = app.listen(port)
      await once(server, 'listening')
      port = (/** @type {import('net').AddressInfo} */ (server.address())).port
    })

    beforeEach(async () => {
      requestCookie = sinon.stub()
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'cookie-parser-rules.json'),
        },
      }))
      setTestBlockingTemplates()
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close()
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
            Cookie: 'key=testattack',
          },
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
