'use strict'

const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

withVersions('express', 'express', version => {
  describe('Api Security', () => {
    let port, server

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()

      const app = express()
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

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not get the schema', async () => {
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: {
            enabled: true,
            requestSampling: 0
          }
        }
      }))

      const res = await axios.post(`http://localhost:${port}/`, { key: 'testattack' })

      await agent.use((traces) => {
        const span = traces[0][0]
        expect(span.meta).not.to.haveOwnProperty('_dd.appsec.s.req.body')
      })

      expect(res.status).to.be.equal(200)
      expect(res.data).to.be.equal('DONE')
    })

    it('should get the schema', async () => {
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'api_security_rules.json'),
          apiSecurity: {
            enabled: true,
            requestSampling: 1
          }
        }
      }))

      const res = await axios.post(`http://localhost:${port}/`, { key: 'testattack' })

      await agent.use((traces) => {
        const span = traces[0][0]
        expect(span.meta).to.haveOwnProperty('_dd.appsec.s.req.body')
        expect(span.meta['_dd.appsec.s.req.body']).to.be.equal('H4sIAAAAAAAAA4u2iAUA8YntnQMAAAA=')
      })

      expect(res.status).to.be.equal(200)
      expect(res.data).to.be.equal('DONE')
    })
  })
})
