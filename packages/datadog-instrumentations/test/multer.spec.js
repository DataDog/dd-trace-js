'use strict'

const axios = require('axios')
const { expect } = require('chai')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('multer', 'multer', version => {
  describe('multer parser instrumentation', () => {
    const multerReadCh = dc.channel('datadog:multer:read:finish')
    let port, server, middlewareProcessBodyStub, formData

    before(() => {
      return agent.load(['http', 'express', 'multer'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const multer = require(`../../../versions/multer@${version}`).get()
      const uploadToMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200000 } })

      const app = express()

      app.post('/', uploadToMemory.single('file'), (req, res) => {
        middlewareProcessBodyStub(req.body.key)
        res.end('DONE')
      })
      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      middlewareProcessBodyStub = sinon.stub()

      formData = new FormData()
      formData.append('key', 'value')
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not abort the request by default', async () => {
      const res = await axios.post(`http://localhost:${port}/`, formData)

      expect(middlewareProcessBodyStub).to.be.calledOnceWithExactly(formData.get('key'))
      expect(res.data).to.be.equal('DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      multerReadCh.subscribe(noop)

      try {
        const res = await axios.post(`http://localhost:${port}/`, formData)

        expect(middlewareProcessBodyStub).to.be.calledOnceWithExactly(formData.get('key'))
        expect(res.data).to.be.equal('DONE')
      } finally {
        multerReadCh.unsubscribe(noop)
      }
    })

    it('should abort the request when abortController.abort() is called', async () => {
      function blockRequest ({ res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      multerReadCh.subscribe(blockRequest)

      try {
        const res = await axios.post(`http://localhost:${port}/`, formData)

        expect(middlewareProcessBodyStub).not.to.be.called
        expect(res.data).to.be.equal('BLOCKED')
      } finally {
        multerReadCh.unsubscribe(blockRequest)
      }
    })

    it('should not lose the http async context', async () => {
      let store
      let payload

      function handler (data) {
        store = storage('legacy').getStore()
        payload = data
      }
      multerReadCh.subscribe(handler)

      try {
        const res = await axios.post(`http://localhost:${port}/`, formData)

        expect(store).to.have.property('req', payload.req)
        expect(store).to.have.property('res', payload.res)
        expect(store).to.have.property('span')

        expect(middlewareProcessBodyStub).to.be.calledOnceWithExactly(formData.get('key'))
        expect(res.data).to.be.equal('DONE')
      } finally {
        multerReadCh.unsubscribe(handler)
      }
    })
  })
})
