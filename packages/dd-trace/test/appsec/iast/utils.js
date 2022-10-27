const getPort = require('get-port')
const agent = require('../../plugins/agent')
const axios = require('axios')
const iast = require('../../../src/appsec/iast')
const Config = require('../../../src/config')

function testInRequest (app, tests) {
  let http
  let listener
  let appListener
  const config = {}

  beforeEach(() => {
    return getPort().then(newPort => {
      config.port = newPort
    })
  })

  beforeEach(() => {
    listener = (req, res) => {
      const appResult = app && app(req, res)
      if (appResult && typeof appResult.then === 'function') {
        appResult.then(() => {
          res.writeHead(200)
          res.end()
        })
      } else {
        res.writeHead(200)
        res.end()
      }
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
      .listen(config.port, 'localhost', () => done())
  })

  afterEach(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

  tests(config)
}

function testThatRequestHasVulnerability (app, vulnerability) {
  function tests (config) {
    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      }))
    })

    afterEach(() => {
      iast.disable()
    })

    it(`should have ${vulnerability} vulnerability`, function (done) {
      agent
        .use(traces => {
          expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
        })
        .then(done)
        .catch(done)
      axios.get(`http://localhost:${config.port}/`).catch(done)
    })
  }

  testInRequest(app, tests)
}

module.exports = { testThatRequestHasVulnerability, testInRequest }
