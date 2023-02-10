'use strict'

const getPort = require('get-port')
const dc = require('diagnostics_channel')
const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')

withVersions('body-parser', 'body-parser', version => {
  describe('body parser instrumentation', () => {
    let express, bodyParser, app, port, server, requestBody

    before(() => {
      return agent.load(['express', 'body-parser'], { client: false })
    })
    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })
    before((done) => {
      express = require('../../../versions/express').get()
      bodyParser = require(`../../../versions/body-parser@${version}`).get()
      app = express()
      app.use(bodyParser.json())
      app.post('/', (req, res) => {
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

    it('abortController should not abort the request', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })
      expect(requestBody).to.be.calledOnce
      expect(res.data).to.be.equal('DONE')
    })

    it('abortController should abort the request', async () => {
      const bodyParserReadCh = dc.channel('datadog:body-parser:read:finish')
      function blockRequest ({ req, res, abortController }) {
        res.end('BLOCKED')
        abortController.abort()
      }
      bodyParserReadCh.subscribe(blockRequest)
      const res = await axios.post(`http://localhost:${port}/`, { key: 'value' })
      expect(requestBody).not.to.be.called
      expect(res.data).to.be.equal('BLOCKED')
      bodyParserReadCh.unsubscribe(blockRequest)
    })
  })
})
