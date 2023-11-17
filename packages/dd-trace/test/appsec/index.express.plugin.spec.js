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
        res.end('DONE')
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
              enabled: true,
              requestSampling: 1.0
            }
          }
        })
      })

      afterEach(() => {
        appsec.disable()
      })

      it('should get the schema', async () => {
        appsec.enable(config)

        const expectedSchema = zlib.gzipSync(JSON.stringify([{ 'key': [8] }])).toString('base64')
        const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

        await agent.use((traces) => {
          const span = traces[0][0]
          expect(span.meta).to.haveOwnProperty('_dd.appsec.s.req.body')
          expect(span.meta['_dd.appsec.s.req.body']).to.be.equal(expectedSchema)
        })

        expect(res.status).to.be.equal(200)
        expect(res.data).to.be.equal('DONE')
      })

      it('should not get the schema', async () => {
        config.appsec.apiSecurity.requestSampling = 0
        appsec.enable(config)

        const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

        await agent.use((traces) => {
          const span = traces[0][0]
          expect(span.meta).not.to.haveOwnProperty('_dd.appsec.s.req.body')
        })

        expect(res.status).to.be.equal(200)
        expect(res.data).to.be.equal('DONE')
      })
    })
  })
})
