const getPort = require('get-port')
const agent = require('../../plugins/agent')
const crypto = require('crypto')
const axios = require('axios')

function testThatRequestHasVulnerability (app, vulnerability) {
  describe('full feature', () => {
    let http
    let listener
    let appListener
    let tracer
    let port

    beforeEach(() => {
      tracer = require('../../../../dd-trace')
      tracer.init({
        flushInterval: 100,
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      })
    })

    beforeEach(() => {
      return getPort().then(newPort => {
        port = newPort
      })
    })

    beforeEach(() => {
      listener = (req, res) => {
        app && app(req, res)
        res.writeHead(200)
        res.end()
      }
    })

    beforeEach(() => {
      return agent.load('http')
        .then(() => {
          http = require('http')
        })
    })

    beforeEach(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => done())
    })

    afterEach(() => {
      appListener && appListener.close()
      app = null
      return agent.close({ ritmReset: false })
    })

    it(`should have ${vulnerability} vulnerability`, function (done) {
      agent
        .use(traces => {
          expect(traces[1][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
        })
        .then(done)
        .catch(done)
      axios.get(`http://localhost:${port}/`).catch(done)
    })
  })
}

module.exports = { testThatRequestHasVulnerability }
