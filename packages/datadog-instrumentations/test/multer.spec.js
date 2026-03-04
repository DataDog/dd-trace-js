'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')

const dc = require('dc-polyfill')
const { after, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
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
        port = (/** @type {import('net').AddressInfo} */ (server.address())).port
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

      sinon.assert.calledOnceWithExactly(middlewareProcessBodyStub, formData.get('key'))
      assert.strictEqual(res.data, 'DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      multerReadCh.subscribe(noop)

      try {
        const res = await axios.post(`http://localhost:${port}/`, formData)

        sinon.assert.calledOnceWithExactly(middlewareProcessBodyStub, formData.get('key'))
        assert.strictEqual(res.data, 'DONE')
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

        sinon.assert.notCalled(middlewareProcessBodyStub)
        assert.strictEqual(res.data, 'BLOCKED')
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

        assert.ok(payload.req)
        assert.ok(payload.res)
        assert.ok(Object.hasOwn(store, 'span'))

        sinon.assert.calledOnceWithExactly(middlewareProcessBodyStub, formData.get('key'))
        assert.strictEqual(res.data, 'DONE')
      } finally {
        multerReadCh.unsubscribe(handler)
      }
    })
  })
})
