const getPort = require('get-port')
const agent = require('../../plugins/agent')
const axios = require('axios')
const iast = require('../../../src/appsec/iast')
const Config = require('../../../src/config')
function testThatRequestHasVulnerability (app, vulnerability) {
  let http
  let listener
  let appListener
  let port

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
    axios.get(`http://localhost:${port}/`).catch(done)
  })
}

module.exports = { testThatRequestHasVulnerability }
