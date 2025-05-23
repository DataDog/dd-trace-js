'use strict'

const axios = require('axios')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')

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
      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'body-parser-rules.json') } }))
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

      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('should block the request when attack is detected', async () => {
      try {
        await axios.post(`http://localhost:${port}/`, { key: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
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
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
        expect(requestBody).not.to.be.called

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          expect(span.metrics['_dd.appsec.truncated.string_length']).to.equal(5000)
          expect(span.metrics['_dd.appsec.truncated.container_size']).to.equal(300)
          expect(span.metrics['_dd.appsec.truncated.container_depth']).to.equal(20)
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
