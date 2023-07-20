'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const dc = require('../../diagnostics_channel')

withVersions('express', 'express', version => {
  describe('express query instrumentation', () => {
    const queryParserReadCh = dc.channel('datadog:query:read:finish')
    let port, server, requestBody

    before(() => {
      return agent.load(['express', 'body-parser'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const app = express()
      app.get('/', (req, res) => {
        requestBody()
        res.end('DONE')
      })
      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
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

      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      queryParserReadCh.subscribe(noop)

      const res = await axios.get(`http://localhost:${port}/`)

      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')

      queryParserReadCh.unsubscribe(noop)
    })

    it('should abort the request when abortController.abort() is called', async () => {
      function blockRequest ({ res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      queryParserReadCh.subscribe(blockRequest)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      expect(requestBody).not.to.be.called
      expect(res.data).to.be.equal('BLOCKED')

      queryParserReadCh.unsubscribe(blockRequest)
    })
  })
})
