'use strict'

const axios = require('axios')
const { expect } = require('chai')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('body-parser', 'body-parser', version => {
  describe('body parser instrumentation', () => {
    const bodyParserReadCh = dc.channel('datadog:body-parser:read:finish')
    let port, server, middlewareProcessBodyStub

    before(() => {
      return agent.load(['http', 'express', 'body-parser'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const bodyParser = require(`../../../versions/body-parser@${version}`).get()
      const app = express()
      app.use(bodyParser.json())
      app.post('/', (req, res) => {
        middlewareProcessBodyStub()
        res.end('DONE')
      })
      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      middlewareProcessBodyStub = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not abort the request by default', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      expect(middlewareProcessBodyStub).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('should not abort the request with non blocker subscription', async () => {
      function noop () {}
      bodyParserReadCh.subscribe(noop)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      expect(middlewareProcessBodyStub).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')

      bodyParserReadCh.unsubscribe(noop)
    })

    it('should abort the request when abortController.abort() is called', async () => {
      function blockRequest ({ res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      bodyParserReadCh.subscribe(blockRequest)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      expect(middlewareProcessBodyStub).not.to.be.called
      expect(res.data).to.be.equal('BLOCKED')

      bodyParserReadCh.unsubscribe(blockRequest)
    })

    it('should not lose the http async context', async () => {
      let store
      let payload

      function handler (data) {
        store = storage('legacy').getStore()
        payload = data
      }
      bodyParserReadCh.subscribe(handler)

      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })

      expect(store).to.have.property('req', payload.req)
      expect(store).to.have.property('res', payload.res)
      expect(store).to.have.property('span')

      expect(middlewareProcessBodyStub).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')

      bodyParserReadCh.unsubscribe(handler)
    })
  })
})
