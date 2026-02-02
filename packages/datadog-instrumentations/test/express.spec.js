'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const dc = require('dc-polyfill')
const { after, before, beforeEach, describe, it } = require('mocha')
const semifies = require('semifies')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
withVersions('express', 'express', version => {
  describe('express query instrumentation', () => {
    const queryParserReadCh = dc.channel('datadog:query:read:finish')
    let port, server, requestBody, express

    before(() => {
      return agent.load(['express', 'body-parser'], { client: false })
    })

    before((done) => {
      express = require(`../../../versions/express@${version}`).get()
      const app = express()
      app.get('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })
      server = app.listen(0, () => {
        port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        done()
      })
    })

    beforeEach(async () => {
      requestBody = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not abort the request by default', async () => {
      const res = await axios.get(`http://localhost:${port}/`)

      sinon.assert.calledOnce(requestBody)
      assert.strictEqual(res.data, 'DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      queryParserReadCh.subscribe(noop)

      const res = await axios.get(`http://localhost:${port}/`)

      sinon.assert.calledOnce(requestBody)
      assert.strictEqual(res.data, 'DONE')

      queryParserReadCh.unsubscribe(noop)
    })

    it('should abort the request when abortController.abort() is called', async () => {
      function blockRequest ({ res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      queryParserReadCh.subscribe(blockRequest)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      sinon.assert.notCalled(requestBody)
      assert.strictEqual(res.data, 'BLOCKED')

      queryParserReadCh.unsubscribe(blockRequest)
    })

    if (semifies(version, '4')) {
      // Router does not exist in Express 5
      it('should work correctly when router[method] is called without handler', () => {
        const router = express.Router()
        assert.doesNotThrow(() => { router.bind('/test') })
      })
    }
  })
})
