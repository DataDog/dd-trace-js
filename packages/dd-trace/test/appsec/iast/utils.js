'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const getPort = require('get-port')
const agent = require('../../plugins/agent')
const axios = require('axios')
const iast = require('../../../src/appsec/iast')
const Config = require('../../../src/config')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')

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
    return agent.load('http', undefined, { flushInterval: 1 })
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

function testOutsideRequestHasVulnerability (fnToTest, vulnerability) {
  beforeEach(async () => {
    await agent.load()
  })
  afterEach(() => {
    return agent.close({ ritmReset: false })
  })
  beforeEach(() => {
    const tracer = require('../../..')
    iast.enable(new Config({
      experimental: {
        iast: {
          enabled: true,
          requestSampling: 100
        }
      }
    }), tracer)
  })

  afterEach(() => {
    iast.disable()
  })
  it(`should detect ${vulnerability} vulnerability out of request`, function (done) {
    agent
      .use(traces => {
        expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
      })
      .then(done)
      .catch(done)
    fnToTest()
  })
}

let index = 0
function copyFileToTmp (src) {
  const srcName = `dd-iast-${index++}-${path.basename(src)}`
  const dest = path.join(os.tmpdir(), srcName)
  fs.copyFileSync(src, dest)
  return dest
}

function prepareTestServerForIast (description, tests) {
  describe(description, () => {
    const config = {}
    let http
    let listener
    let appListener
    let app

    before(() => {
      return getPort().then(newPort => {
        config.port = newPort
      })
    })

    before(() => {
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

    before(() => {
      return agent.load('http', undefined, { flushInterval: 1 })
        .then(() => {
          http = require('http')
        })
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(config.port, 'localhost', () => done())
    })

    beforeEach(async () => {
      vulnerabilityReporter.clearCache()
    })

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
      app = null
    })

    after(() => {
      appListener && appListener.close()
      return agent.close({ ritmReset: false })
    })

    function testThatRequestHasVulnerability (fn, vulnerability) {
      it(`should have ${vulnerability} vulnerability`, function (done) {
        this.timeout(5000)
        app = fn
        agent
          .use(traces => {
            expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`).catch(done)
      })
    }

    function testThatRequestHasNoVulnerability (fn, vulnerability) {
      it(`should not have ${vulnerability} vulnerability`, function (done) {
        app = fn
        agent
          .use(traces => {
            // iastJson == undefiend is valid
            const iastJson = traces[0][0].meta['_dd.iast.json'] || ''
            expect(iastJson).to.not.include(`"${vulnerability}"`)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`).catch(done)
      })
    }
    tests(testThatRequestHasVulnerability, testThatRequestHasNoVulnerability, config)
  })
}

module.exports = {
  testOutsideRequestHasVulnerability,
  testInRequest,
  copyFileToTmp,
  prepareTestServerForIast
}
