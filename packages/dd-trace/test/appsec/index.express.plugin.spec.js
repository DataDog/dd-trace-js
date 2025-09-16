'use strict'

const semver = require('semver')
const Axios = require('axios')
const { assert } = require('chai')
const sinon = require('sinon')
const path = require('node:path')
const zlib = require('node:zlib')

const { NODE_MAJOR } = require('../../../../version')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')
const { withVersions } = require('../setup/mocha')

withVersions('express', 'express', version => {
  if (semver.intersects(version, '<=4.10.5') && NODE_MAJOR >= 24) {
    describe.skip(`refusing to run tests as express@${version} is incompatible with Node.js ${NODE_MAJOR}`)
    return
  }

  describe('Suspicious request blocking - path parameters', () => {
    let server, paramCallbackSpy, axios

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../versions/express@${version}`).get()

      const app = express()

      app.get('/multiple-path-params/:parameter1/:parameter2', (req, res) => {
        res.send('DONE')
      })

      const nestedRouter = express.Router({ mergeParams: true })
      nestedRouter.get('/:nestedDuplicatedParameter', (req, res) => {
        res.send('DONE')
      })

      app.use('/nested/:nestedDuplicatedParameter', nestedRouter)

      app.get('/callback-path-param/:callbackedParameter', (req, res) => {
        res.send('DONE')
      })

      const paramCallback = (req, res, next) => {
        next()
      }

      paramCallbackSpy = sinon.spy(paramCallback)

      app.param('callbackedParameter', paramCallbackSpy)

      server = app.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({ baseURL: `http://localhost:${port}` })
        done()
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

    describe('nested routers', () => {
      it('should not block the request when attack is not detected', async () => {
        const res = await axios.get('/nested/safe_param/safe_param')

        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
      })

      it('should block the request when attack is detected in the nested paremeter', async () => {
        try {
          await axios.get('/nested/safe_param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected in the parent paremeter', async () => {
        try {
          await axios.get('/nested/testattack/safe_param')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })

      it('should block the request when attack is detected both parameters', async () => {
        try {
          await axios.get('/nested/testattack/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
        }
      })
    })

    describe('path parameter callback', () => {
      it('should not block the request when attack is not detected', async () => {
        const res = await axios.get('/callback-path-param/safe_param')
        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
        sinon.assert.calledOnce(paramCallbackSpy)
      })

      it('should block the request when attack is detected', async () => {
        try {
          await axios.get('/callback-path-param/testattack')

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
          assert.deepEqual(e.response.data, JSON.parse(json))
          sinon.assert.notCalled(paramCallbackSpy)
        }
      })
    })
  })

  describe('Suspicious request blocking - query', () => {
    let server, requestBody, axios

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../versions/express@${version}`).get()

      const app = express()

      app.get('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })

      server = app.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({ baseURL: `http://localhost:${port}` })
        done()
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

  describe('Api Security', () => {
    let config, server, axios

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../versions/express@${version}`).get()
      const bodyParser = require('../../../../versions/body-parser').get()

      const app = express()
      app.use(bodyParser.json())

      app.post('/', (req, res) => {
        res.send('DONE')
      })

      app.post('/sendjson', (req, res) => {
        res.send({ sendResKey: 'sendResValue' })
      })

      app.post('/jsonp', (req, res) => {
        res.jsonp({ jsonpResKey: 'jsonpResValue' })
      })

      app.post('/json', (req, res) => {
        res.json({ jsonResKey: 'jsonResValue' })
      })

      server = app.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({ baseURL: `http://localhost:${port}` })
        done()
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
            enabled: true
          }
        }
      })
    })

    afterEach(() => {
      appsec.disable()
    })

    describe('with sample delay 10', () => {
      beforeEach(() => {
        config.appsec.apiSecurity.sampleDelay = 10
        appsec.enable(config)
      })

      function formatSchema (body) {
        return zlib.gzipSync(JSON.stringify(body)).toString('base64')
      }

      it('should get the request body schema', async () => {
        const expectedRequestBodySchema = formatSchema([{ key: [8] }])

        const res = await axios.post('/', { key: 'value' })

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.property(span.meta, '_dd.appsec.s.req.body')
          assert.notProperty(span.meta, '_dd.appsec.s.res.body')
          assert.equal(span.meta['_dd.appsec.s.req.body'], expectedRequestBodySchema)
        })

        assert.equal(res.status, 200)
        assert.equal(res.data, 'DONE')
      })

      it('should get the response body schema with res.send method with object', async () => {
        const expectedResponseBodySchema = formatSchema([{ sendResKey: [8] }])
        const res = await axios.post('/sendjson', { key: 'value' })

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.s.res.body'], expectedResponseBodySchema)
        })

        assert.equal(res.status, 200)
        assert.deepEqual(res.data, { sendResKey: 'sendResValue' })
      })

      it('should get the response body schema with res.json method', async () => {
        const expectedResponseBodySchema = formatSchema([{ jsonResKey: [8] }])
        const res = await axios.post('/json', { key: 'value' })

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.s.res.body'], expectedResponseBodySchema)
        })

        assert.equal(res.status, 200)
        assert.deepEqual(res.data, { jsonResKey: 'jsonResValue' })
      })

      it('should get the response body schema with res.jsonp method', async () => {
        const expectedResponseBodySchema = formatSchema([{ jsonpResKey: [8] }])
        const res = await axios.post('/jsonp', { key: 'value' })

        await agent.assertSomeTraces((traces) => {
          const span = traces[0][0]
          assert.equal(span.meta['_dd.appsec.s.res.body'], expectedResponseBodySchema)
        })

        assert.equal(res.status, 200)
        assert.deepEqual(res.data, { jsonpResKey: 'jsonpResValue' })
      })
    })

    it('should not get the schema', async () => {
      config.appsec.apiSecurity.enabled = false
      config.appsec.apiSecurity.sampleDelay = 10
      appsec.enable(config)

      const res = await axios.post('/', { key: 'value' })

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.notProperty(span.meta, '_dd.appsec.s.req.body')
        assert.notProperty(span.meta, '_dd.appsec.s.res.body')
      })

      assert.equal(res.status, 200)
      assert.equal(res.data, 'DONE')
    })
  })
})
