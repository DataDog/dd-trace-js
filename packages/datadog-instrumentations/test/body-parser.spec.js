'use strict'

const getPort = require('get-port')
const dc = require('dc-polyfill')
const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')

withVersions('body-parser', 'body-parser', version => {
  describe('body parser instrumentation', () => {
    const bodyParserReadCh = dc.channel('datadog:body-parser:read:finish')
    let port, server, middlewareProcessBodyStub

    before(() => {
      return agent.load(['express', 'body-parser'], { client: false })
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
      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
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
  })
})
