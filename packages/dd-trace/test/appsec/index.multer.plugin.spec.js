'use strict'

const { channel } = require('dc-polyfill')
const axios = require('axios')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')

const multerReadCh = channel('datadog:multer:read:finish')

withVersions('multer', 'multer', version => {
  describe('Suspicious request blocking - multer', () => {
    let port, server, requestBody, onMulterRead

    before(() => {
      return agent.load(['express', 'multer', 'http'], { client: false })
    })

    before((done) => {
      const express = require('../../../../versions/express').get()
      const multer = require(`../../../../versions/multer@${version}`).get()
      const uploadToMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200000 } })

      const app = express()

      app.post('/', uploadToMemory.single('file'), (req, res) => {
        requestBody(req)
        res.end('DONE')
      })

      server = app.listen(port, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
      onMulterRead = sinon.stub()
      multerReadCh.subscribe(onMulterRead)

      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'body-parser-rules.json') } }))
    })

    afterEach(() => {
      sinon.restore()
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not block the request without an attack', async () => {
      const form = new FormData()
      form.append('key', 'value')

      const res = await axios.post(`http://localhost:${port}/`, form)

      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('should block the request when attack is detected', async () => {
      try {
        const form = new FormData()
        form.append('key', 'testattack')

        await axios.post(`http://localhost:${port}/`, form)

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
        expect(requestBody).not.to.be.called
      }
    })
  })
})
