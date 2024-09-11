'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

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
      .listen(0, 'localhost', () => {
        config.port = appListener.address().port
        done()
      })
  })

  afterEach(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

  tests(config)
}

function testOutsideRequestHasVulnerability (fnToTest, vulnerability, plugins, timeout) {
  beforeEach(async () => {
    await agent.load(plugins)
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
    if (timeout) {
      this.timeout(timeout)
    }
    agent
      .use(traces => {
        expect(traces[0][0].meta['_dd.iast.json']).to.include(`"${vulnerability}"`)
        expect(traces[0][0].metrics['_dd.iast.enabled']).to.be.equal(1)
      }, { timeoutMs: 10000 })
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

function beforeEachIastTest (iastConfig) {
  iastConfig = iastConfig || {
    enabled: true,
    requestSampling: 100,
    maxConcurrentRequests: 100,
    maxContextOperations: 100
  }

  beforeEach(() => {
    vulnerabilityReporter.clearCache()
    iast.enable(new Config({
      experimental: {
        iast: iastConfig
      }
    }))
  })
}

function endResponse (res, appResult) {
  if (appResult && typeof appResult.then === 'function') {
    appResult.then(() => {
      if (!res.headersSent) {
        res.writeHead(200)
      }
      res.end()
    })
  } else {
    if (!res.headersSent) {
      res.writeHead(200)
    }
    res.end()
  }
}

function checkNoVulnerabilityInRequest (vulnerability, config, done, makeRequest) {
  agent
    .use(traces => {
      // iastJson == undefiend is valid
      const iastJson = traces[0][0].meta['_dd.iast.json'] || ''
      expect(iastJson).to.not.include(`"${vulnerability}"`)
    })
    .then(done)
    .catch(done)
  if (makeRequest) {
    makeRequest(done, config)
  } else {
    axios.get(`http://localhost:${config.port}/`).catch(done)
  }
}

function checkVulnerabilityInRequest (vulnerability, occurrencesAndLocation, cb, makeRequest, config, done) {
  let location
  let occurrences = occurrencesAndLocation
  if (occurrencesAndLocation !== null && typeof occurrencesAndLocation === 'object') {
    location = occurrencesAndLocation.location
    occurrences = occurrencesAndLocation.occurrences
  }
  agent
    .use(traces => {
      expect(traces[0][0].metrics['_dd.iast.enabled']).to.be.equal(1)
      expect(traces[0][0].meta).to.have.property('_dd.iast.json')
      const vulnerabilitiesTrace = JSON.parse(traces[0][0].meta['_dd.iast.json'])
      expect(vulnerabilitiesTrace).to.not.be.null
      const vulnerabilitiesCount = new Map()
      vulnerabilitiesTrace.vulnerabilities.forEach(v => {
        let count = vulnerabilitiesCount.get(v.type) || 0
        vulnerabilitiesCount.set(v.type, ++count)
      })

      expect(vulnerabilitiesCount.get(vulnerability)).to.be.greaterThan(0)
      if (occurrences) {
        expect(vulnerabilitiesCount.get(vulnerability)).to.equal(occurrences)
      }

      if (location) {
        let found = false
        vulnerabilitiesTrace.vulnerabilities.forEach(v => {
          if (v.type === vulnerability && v.location.path.endsWith(location.path)) {
            if (location.line) {
              if (location.line === v.location.line) {
                found = true
              }
            } else {
              found = true
            }
          }
        })

        if (!found) {
          throw new Error(`Expected ${vulnerability} on ${location.path}:${location.line}`)
        }
      }

      if (cb) {
        cb(vulnerabilitiesTrace.vulnerabilities.filter(v => v.type === vulnerability))
      }
    })
    .then(done)
    .catch(done)
  if (makeRequest) {
    makeRequest(done, config)
  } else {
    axios.get(`http://localhost:${config.port}/`).catch(done)
  }
}

function prepareTestServerForIast (description, tests, iastConfig) {
  describe(description, () => {
    const config = {}
    let http
    let listener
    let appListener
    let app

    before(() => {
      listener = (req, res) => {
        endResponse(res, app && app(req, res))
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
        .listen(0, 'localhost', () => {
          config.port = appListener.address().port
          done()
        })
    })

    beforeEachIastTest(iastConfig)

    afterEach(() => {
      iast.disable()
      app = null
    })

    after(() => {
      appListener && appListener.close()
      return agent.close({ ritmReset: false })
    })

    function testThatRequestHasVulnerability (fn, vulnerability, occurrences, cb, makeRequest) {
      it(`should have ${vulnerability} vulnerability`, function (done) {
        this.timeout(5000)
        app = fn
        checkVulnerabilityInRequest(vulnerability, occurrences, cb, makeRequest, config, done)
      })
    }

    function testThatRequestHasNoVulnerability (fn, vulnerability, makeRequest) {
      it(`should not have ${vulnerability} vulnerability`, function (done) {
        app = fn
        checkNoVulnerabilityInRequest(vulnerability, config, done, makeRequest)
      })
    }
    tests(testThatRequestHasVulnerability, testThatRequestHasNoVulnerability, config)
  })
}

function prepareTestServerForIastInExpress (description, expressVersion, loadMiddlewares, tests, iastConfig) {
  if (arguments.length === 3) {
    tests = loadMiddlewares
    loadMiddlewares = undefined
  }

  describe(description, () => {
    const config = {}
    let listener, app, server

    before(() => {
      return agent.load(['express', 'http'], { client: false }, { flushInterval: 1 })
    })

    before(() => {
      listener = (req, res) => {
        endResponse(res, app && app(req, res))
      }
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const bodyParser = require('../../../../../versions/body-parser').get()
      const expressApp = express()

      if (loadMiddlewares) loadMiddlewares(expressApp)

      expressApp.use(bodyParser.json())
      try {
        const cookieParser = require('../../../../../versions/cookie-parser').get()
        expressApp.use(cookieParser())
      } catch (e) {
        // do nothing, in some scenarios we don't have cookie-parser dependency available, and we don't need
        // it in all the iast tests
      }

      expressApp.all('/', listener)

      server = expressApp.listen(0, () => {
        config.port = server.address().port
        done()
      })
    })

    beforeEachIastTest(iastConfig)

    afterEach(() => {
      iast.disable()
      app = null
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    function testThatRequestHasVulnerability (fn, vulnerability, occurrencesAndLocation, cb, makeRequest) {
      let testDescription
      if (fn !== null && typeof fn === 'object') {
        const obj = fn
        fn = obj.fn
        vulnerability = obj.vulnerability
        occurrencesAndLocation = obj.occurrencesAndLocation || obj.occurrences
        cb = obj.cb
        makeRequest = obj.makeRequest
        testDescription = obj.testDescription || testDescription
      }

      testDescription = testDescription || `should have ${vulnerability} vulnerability`

      it(testDescription, function (done) {
        this.timeout(5000)
        app = fn

        checkVulnerabilityInRequest(vulnerability, occurrencesAndLocation, cb, makeRequest, config, done)
      })
    }

    function testThatRequestHasNoVulnerability (fn, vulnerability, makeRequest) {
      let testDescription
      if (fn !== null && typeof fn === 'object') {
        const obj = fn
        fn = obj.fn
        vulnerability = obj.vulnerability
        makeRequest = obj.makeRequest
        testDescription = obj.testDescription || testDescription
      }

      testDescription = testDescription || `should not have ${vulnerability} vulnerability`

      it(testDescription, function (done) {
        app = fn
        checkNoVulnerabilityInRequest(vulnerability, config, done, makeRequest)
      })
    }

    tests(testThatRequestHasVulnerability, testThatRequestHasNoVulnerability, config)
  })
}

module.exports = {
  testOutsideRequestHasVulnerability,
  testInRequest,
  copyFileToTmp,
  prepareTestServerForIast,
  prepareTestServerForIastInExpress
}
