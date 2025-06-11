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
  describe('Suspicious request blocking - path parameters', () => {
    let server, paramHookSpy, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${version}`).get()

      const app = fastify()

      app.get('/multiple-path-params/:parameter1/:parameter2', (request, reply) => {
        reply.send('DONE')
      })

      app.register(async function (nested) {
        nested.get('/:nestedDuplicatedParameter', async (request, reply) => {
          reply.send('DONE')
        })
      }, { prefix: '/nested/:parentParam' })

      // Route with hook for path parameters
      const paramHook = (request, reply, done) => {
        done()
      }

      paramHookSpy = sinon.spy(paramHook)

      app.addHook('preHandler', paramHookSpy)

      app.get('/callback-path-param/:callbackedParameter', (request, reply) => {
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
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'express-rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
      sinon.reset()
    })

    describe('route with multiple path parameters', () => {
      it('should not block the request when attack is not detected', async () => {
        const res = await axios.get('/multiple-path-params/safe_param/safe_param')

        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
      })

      it('should block the request when attack is detected in both parameters', async () => {
        try {
          await axios.get('/multiple-path-params/testattack/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected in the first parameter', async () => {
        try {
          await axios.get('/multiple-path-params/testattack/safe_param')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected in the second parameter', async () => {
        try {
          await axios.get('/multiple-path-params/safe_param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })
    })

    describe('nested routes', () => {
      it('should not block the request when attack is not detected', async () => {
        const res = await axios.get('/nested/safe_param/safe_param')

        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
      })

      it('should block the request when attack is detected in the nested parameter', async () => {
        try {
          await axios.get('/nested/safe_param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected in the parent parameter', async () => {
        try {
          await axios.get('/nested/testattack/safe_param')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected in both parameters', async () => {
        try {
          await axios.get('/nested/testattack/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })
    })

    describe('path parameter with hook', () => {
      it('should not block the request when attack is not detected', async () => {
        const res = await axios.get('/callback-path-param/safe_param')
        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
        sinon.assert.calledOnce(paramHookSpy)
      })

      it('should block the request when attack is detected', async () => {
        try {
          await axios.get('/callback-path-param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
          sinon.assert.notCalled(paramHookSpy)
        }
      })
    })
  })
})

const createNestedObject = (n, obj) => {
  if (n > 0) {
    return { a: createNestedObject(n - 1, obj) }
  }
  return obj
}
