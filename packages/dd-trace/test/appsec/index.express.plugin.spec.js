'use strict'

const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')
const zlib = require('zlib')

withVersions('express', 'express', version => {
  describe('Suspicious request blocking - query', () => {
    let port, server, requestBody

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()
      const bodyParser = require('../../../../versions/body-parser').get()

      const app = express()
      app.use(bodyParser.json())

      app.get('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })

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
        res.jsonp({ jsonResKey: 'jsonResValue' })
      })

      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    describe('Blocking', () => {
      beforeEach(async () => {
        requestBody = sinon.stub()
        appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'express-rules.json') } }))
      })

      afterEach(() => {
        appsec.disable()
      })

      it('should not block the request without an attack', async () => {
        const res = await axios.get(`http://localhost:${port}/?key=value`)

        expect(requestBody).to.be.calledOnce
        expect(res.data).to.be.equal('DONE')
      })

      it('should block the request when attack is detected', async () => {
        try {
          await axios.get(`http://localhost:${port}/?key=testattack`)

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          expect(e.response.status).to.be.equals(403)
          expect(e.response.data).to.be.deep.equal(JSON.parse(json))
          expect(requestBody).not.to.be.called
        }
      })
    })

    describe('Api Security', () => {
      let config

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

      describe('with requestSampling 1.0', () => {
        beforeEach(() => {
          config.appsec.apiSecurity.requestSampling = 1.0
          appsec.enable(config)
        })

        function formatSchema (body) {
          return zlib.gzipSync(JSON.stringify(body)).toString('base64')
        }

        it('should get the request body schema', async () => {
          const expectedRequestBodySchema = formatSchema([{ 'key': [8] }])
          const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

          await agent.use((traces) => {
            const span = traces[0][0]
            expect(span.meta).to.haveOwnProperty('_dd.appsec.s.req.body')
            expect(span.meta).not.to.haveOwnProperty('_dd.appsec.s.res.body')
            expect(span.meta['_dd.appsec.s.req.body']).to.be.equal(expectedRequestBodySchema)
          })

          expect(res.status).to.be.equal(200)
          expect(res.data).to.be.equal('DONE')
        })

        it('should get the response body schema with res.send method with object', async () => {
          const expectedResponseBodySchema = formatSchema([{ 'sendResKey': [8] }])
          const res = await axios.post(`http://localhost:${port}/sendjson`, { key: 'value' })

          await agent.use((traces) => {
            const span = traces[0][0]
            expect(span.meta['_dd.appsec.s.res.body']).to.be.equal(expectedResponseBodySchema)
          })

          expect(res.status).to.be.equal(200)
          expect(res.data).to.be.deep.equal({ sendResKey: 'sendResValue' })
        })

        it('should get the response body schema with res.json method', async () => {
          const expectedResponseBodySchema = formatSchema([{ 'jsonResKey': [8] }])
          const res = await axios.post(`http://localhost:${port}/json`, { key: 'value' })

          await agent.use((traces) => {
            const span = traces[0][0]
            expect(span.meta['_dd.appsec.s.res.body']).to.be.equal(expectedResponseBodySchema)
          })

          expect(res.status).to.be.equal(200)
          expect(res.data).to.be.deep.equal({ jsonResKey: 'jsonResValue' })
        })

        it('should get the response body schema with res.jsonp method', async () => {
          const expectedResponseBodySchema = formatSchema([{ 'jsonpResKey': [8] }])
          const res = await axios.post(`http://localhost:${port}/jsonp`, { key: 'value' })

          await agent.use((traces) => {
            const span = traces[0][0]
            expect(span.meta['_dd.appsec.s.res.body']).to.be.equal(expectedResponseBodySchema)
          })

          expect(res.status).to.be.equal(200)
          expect(res.data).to.be.deep.equal({ jsonpResKey: 'jsonpResValue' })
        })
      })

      it('should not get the schema', async () => {
        config.appsec.apiSecurity.requestSampling = 0
        appsec.enable(config)

        const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

        await agent.use((traces) => {
          const span = traces[0][0]
          expect(span.meta).not.to.haveOwnProperty('_dd.appsec.s.req.body')
          expect(span.meta).not.to.haveOwnProperty('_dd.appsec.s.res.body')
        })

        expect(res.status).to.be.equal(200)
        expect(res.data).to.be.equal('DONE')
      })
    })
  })
})
