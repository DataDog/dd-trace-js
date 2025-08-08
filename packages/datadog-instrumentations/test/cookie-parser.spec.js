'use strict'

const { assert } = require('chai')
const dc = require('dc-polyfill')
const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('cookie-parser', 'cookie-parser', version => {
  describe('cookie parser instrumentation', () => {
    const cookieParserReadCh = dc.channel('datadog:cookie-parser:read:finish')
    let port, server, middlewareProcessCookieStub

    before(() => {
      return agent.load(['express', 'cookie-parser'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const cookieParser = require(`../../../versions/cookie-parser@${version}`).get()
      const app = express()
      app.use(cookieParser())
      app.post('/', (req, res) => {
        middlewareProcessCookieStub()
        res.end('DONE')
      })
      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      middlewareProcessCookieStub = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not abort the request by default', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      sinon.assert.calledOnce(middlewareProcessCookieStub)
      assert.equal(res.data, 'DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      cookieParserReadCh.subscribe(noop)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      sinon.assert.calledOnce(middlewareProcessCookieStub)
      assert.equal(res.data, 'DONE')

      cookieParserReadCh.unsubscribe(noop)
    })

    it('should abort the request when abortController.abort() is called', async () => {
      function blockRequest ({ res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      cookieParserReadCh.subscribe(blockRequest)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      sinon.assert.notCalled(middlewareProcessCookieStub)
      assert.equal(res.data, 'BLOCKED')

      cookieParserReadCh.unsubscribe(blockRequest)
    })
  })
})
