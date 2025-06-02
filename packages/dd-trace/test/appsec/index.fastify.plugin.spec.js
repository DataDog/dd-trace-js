'use strict'

const Axios = require('axios')
const { assert } = require('chai')
const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')

withVersions('fastify', 'fastify', version => {
  describe('Suspicious request blocking - query', () => {
    let server, requestBody, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${version}`).get()

      const app = fastify()

      app.get('/', (request, reply) => {
        requestBody()
        reply.send('DONE')
      })

      getPort().then((port) => {
        app.listen({ port }, () => {
          axios = Axios.create({ baseURL: `http://localhost:${port}` })
          done()
        })
        server = app.server
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'express-rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('should not block the request without an attack', async () => {
      const res = await axios.get('/?key=value')

      assert.equal(res.status, 200)
      assert.equal(res.data, 'DONE')
      sinon.assert.calledOnce(requestBody)
    })

    it('should block the request when attack is detected', async () => {
      try {
        await axios.get('/?key=testattack')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.equal(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
        sinon.assert.notCalled(requestBody)
      }
    })
  })

  describe('Suspicious request blocking - body', () => {
    let server, requestBody, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${version}`).get()

      const app = fastify()

      app.post('/', (request, reply) => {
        requestBody()
        reply.send('DONE')
      })

      getPort().then((port) => {
        app.listen({ port }, () => {
          axios = Axios.create({ baseURL: `http://localhost:${port}` })
          done()
        })
        server = app.server
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'body-parser-rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('should not block the request without an attack', async () => {
      const res = await axios.post('/', { key: 'value' })

      assert.equal(res.status, 200)
      assert.equal(res.data, 'DONE')
      sinon.assert.calledOnce(requestBody)
    })

    it('should block the request when attack is detected', async () => {
      try {
        await axios.post('/', { key: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.equal(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
        sinon.assert.notCalled(requestBody)
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

        await axios.post('/', { complexPayload })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.equal(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
        sinon.assert.notCalled(requestBody)

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.metrics['_dd.appsec.truncated.string_length'], 5000)
          assert.equal(span.metrics['_dd.appsec.truncated.container_size'], 300)
          assert.equal(span.metrics['_dd.appsec.truncated.container_depth'], 20)
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
