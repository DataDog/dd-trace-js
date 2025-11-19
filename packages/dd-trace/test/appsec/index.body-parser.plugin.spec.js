'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const axios = require('axios')
const { expect } = require('chai')
const sinon = require('sinon')

const appsec = require('../../src/appsec')
const { json } = require('../../src/appsec/blocked_templates')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { withVersions } = require('../setup/mocha')
withVersions('body-parser', 'body-parser', version => {
  describe('Suspicious request blocking - body-parser', () => {
    let port, server, requestBody

    before(() => {
      return agent.load(['express', 'body-parser', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()
      const bodyParser = require(`../../../../versions/body-parser@${version}`).get()

      const app = express()
      app.use(bodyParser.json())
      app.post('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })

      server = app.listen(port, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'body-parser-rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not block the request without an attack', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      sinon.assert.calledOnce(requestBody)
      assert.strictEqual(res.data, 'DONE')
    })

    it('should block the request when attack is detected', async () => {
      try {
        await axios.post(`http://localhost:${port}/`, { key: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(json))
        expect(requestBody).not.to.be.called
      }
    })

    it('should block the request when attack is detected and report truncation metrics', async () => {
      try {
        const longValue = 'testattack'.repeat(500)

        const largeObject = {}
        for (let i = 0; i < 300; ++i) {
          largeObject[`key${i}`] = `value${i}`
        }

        const deepObject = createNestedObject(25, { value: 'a' })

        const complexPayload = {
          deepObject,
          longValue,
          largeObject
        }

        await axios.post(`http://localhost:${port}/`, { complexPayload })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(json))
        expect(requestBody).not.to.be.called

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.strictEqual(span.metrics['_dd.appsec.truncated.string_length'], 5000)
          assert.strictEqual(span.metrics['_dd.appsec.truncated.container_size'], 300)
          assert.strictEqual(span.metrics['_dd.appsec.truncated.container_depth'], 20)
        })
      }
    })
  })
})

const createNestedObject = (n, obj) => {
  if (n > 0) {
    return { a: createNestedObject(n - 1, obj) }
  }
  return obj
}
