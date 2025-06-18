'use strict'

const Axios = require('axios')
const { assert } = require('chai')
const getPort = require('get-port')
const path = require('path')
const semver = require('semver')
const zlib = require('zlib')
const fs = require('node:fs')
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
          rules: path.join(__dirname, 'rules-example.json')
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

        await agent.assertFirstTraceSpan({
          metrics: {
            '_dd.appsec.truncated.string_length': 5000,
            '_dd.appsec.truncated.container_size': 300,
            '_dd.appsec.truncated.container_depth': 20
          }
        })
      }
    })
  })

  describe('Appsec blocking with schema validation', () => {
    let server, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${version}`).get()

      const app = fastify()

      app.post('/schema-validated', {
        schema: {
          body: {
            type: 'object',
            required: ['validField'],
            properties: {
              validField: { type: 'string' }
            }
          }
        }
      }, (request, reply) => {
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
          rules: path.join(__dirname, 'body-parser-rules.json')
        }
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('should return 403 for dangerous payloads', async () => {
      // Skip Fastify v1 - different behavior where schema validation takes precedence
      if (semver.lt(semver.coerce(version), '2.0.0')) {
        return
      }

      try {
        await axios.post('/schema-validated', { key: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.equal(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
      }
    })

    it('should return 403 for valid schema with attack content', async () => {
      // Skip Fastify v1 - different behavior where schema validation takes precedence
      if (semver.lt(semver.coerce(version), '2.0.0')) {
        return
      }

      try {
        await axios.post('/schema-validated', { validField: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.equal(e.response.status, 403)
        assert.deepEqual(e.response.data, JSON.parse(json))
      }
    })
  })

  describe('Suspicious request blocking - path parameters', () => {
    // Skip Fastify v1 - preValidation hook is not supported
    if (semver.lt(semver.coerce(version), '2.0.0')) {
      return
    }

    let server, preHandlerHookSpy, preValidationHookSpy, axios

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
        nested.get('/:nestedParam', async (request, reply) => {
          reply.send('DONE')
        })
      }, { prefix: '/nested/:parentParam' })

      const paramHook = (request, reply, done) => {
        done()
      }

      preHandlerHookSpy = sinon.spy(paramHook)

      app.addHook('preHandler', preHandlerHookSpy)

      const validationHook = (request, reply, done) => {
        done()
      }

      preValidationHookSpy = sinon.spy(validationHook)
      app.addHook('preValidation', preValidationHookSpy)

      app.get('/callback-path-param/:pathParameter', (request, reply) => {
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
          rules: path.join(__dirname, 'rules-example.json')
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
        sinon.assert.calledOnce(preHandlerHookSpy)
        sinon.assert.calledOnce(preValidationHookSpy)
      })

      it('should block the request when attack is detected', async () => {
        try {
          await axios.get('/callback-path-param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
          sinon.assert.notCalled(preHandlerHookSpy)
          sinon.assert.notCalled(preValidationHookSpy)
        }
      })
    })
  })
})

describe('Api Security - Fastify', () => {
  withVersions('fastify', 'fastify', version => {
    let config, server, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${version}`).get()

      const app = fastify()

      app.post('/send', (request, reply) => {
        reply.send({ sendResKey: 'sendResValue' })
      })

      app.post('/return', async (request, reply) => {
        return { returnResKey: 'returnResValue' }
      })

      app.get('/', (request, reply) => {
        reply.send('DONE')
      })

      app.get('/buffer', (request, reply) => {
        reply.send(Buffer.from('DONE'))
      })

      app.get('/stream', (request, reply) => {
        const stream = fs.createReadStream(__filename)
        reply.header('Content-Type', 'application/octet-stream')
        reply.send(stream)
      })

      app.get('/typedarray', (request, reply) => {
        reply.send(new Uint16Array(10))
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

    beforeEach(() => {
      config = new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: {
            enabled: true,
            sampleDelay: 10
          }
        }
      })
      appsec.enable(config)
    })

    afterEach(() => {
      appsec.disable()
    })

    function formatSchema (body) {
      return zlib.gzipSync(JSON.stringify(body)).toString('base64')
    }

    it('should get the response body schema with reply.send', async () => {
      const expectedResponseBodySchema = formatSchema([{ sendResKey: [8] }])
      const res = await axios.post('/send', { key: 'value' })

      await agent.assertFirstTraceSpan({
        meta: {
          '_dd.appsec.s.res.body': expectedResponseBodySchema
        }
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, { sendResKey: 'sendResValue' })
    })

    it('should get the response body schema with return', async () => {
      const expectedResponseBodySchema = formatSchema([{ returnResKey: [8] }])
      const res = await axios.post('/return', { key: 'value' })

      await agent.assertFirstTraceSpan({
        meta: {
          '_dd.appsec.s.res.body': expectedResponseBodySchema
        }
      })

      assert.equal(res.status, 200)
      assert.deepEqual(res.data, { returnResKey: 'returnResValue' })
    })

    it('should not get the schema for string', async () => {
      const res = await axios.get('/')

      await agent.assertFirstTraceSpan(span => {
        assert.notProperty(span.meta, '_dd.appsec.s.res.body')
      })

      assert.equal(res.status, 200)
      assert.equal(res.data, 'DONE')
    })

    it('should not get the schema for Buffer', async () => {
      const res = await axios.get('/buffer')

      await agent.assertFirstTraceSpan(span => {
        if (span.meta) {
          assert.notProperty(span.meta, '_dd.appsec.s.res.body')
        }
      })

      assert.equal(res.status, 200)
      assert.equal(res.data, 'DONE')
    })

    it('should not get the schema for stream', async () => {
      const res = await axios.get('/stream', { responseType: 'arraybuffer' })

      await agent.assertFirstTraceSpan(span => {
        if (span.meta) {
          assert.notProperty(span.meta, '_dd.appsec.s.res.body')
        }
      })

      assert.equal(res.status, 200)
    })

    it('should not get the schema for TypedArray', async () => {
      const res = await axios.get('/typedarray', { responseType: 'arraybuffer' })

      await agent.assertFirstTraceSpan(span => {
        if (span.meta) {
          assert.notProperty(span.meta, '_dd.appsec.s.res.body')
        }
      })

      assert.equal(res.status, 200)
    })
  })
})

const createNestedObject = (n, obj) => {
  if (n > 0) {
    return { a: createNestedObject(n - 1, obj) }
  }
  return obj
}
