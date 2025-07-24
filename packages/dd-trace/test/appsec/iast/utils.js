'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { assert } = require('chai')
const msgpack = require('@msgpack/msgpack')

const agent = require('../../plugins/agent')
const axios = require('axios')
const rewriter = require('../../../src/appsec/iast/taint-tracking/rewriter')
const iast = require('../../../src/appsec/iast')
const Config = require('../../../src/config')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
const overheadController = require('../../../src/appsec/iast/overhead-controller')
const { getWebSpan } = require('../utils')

function testInRequest (app, tests) {
  let http
  let listener
  let appListener
  const config = {}

  before(() => {
    return agent.load('http', undefined, { flushInterval: 1 })
      .then(() => {
        http = require('http')
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
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  tests(config)
}

function testOutsideRequestHasVulnerability (fnToTest, vulnerability, plugins, timeout) {
  beforeEach(async () => {
    vulnerabilityReporter.clearCache()
    await agent.load(plugins)
  })
  afterEach(() => {
    return agent.close({ ritmReset: false })
  })
  beforeEach(() => {
    const tracer = require('../../..')
    const config = new Config({
      experimental: {
        iast: {
          enabled: true,
          requestSampling: 100
        }
      }
    })
    iast.enable(config, tracer)
    rewriter.enable(config)
  })

  afterEach(() => {
    iast.disable()
    rewriter.disable()
  })
  it(`should detect ${vulnerability} vulnerability out of request`, function (done) {
    if (timeout) {
      this.timeout(timeout)
    }
    agent
      .assertSomeTraces(traces => {
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
    overheadController.clearGlobalRouteMap()
    vulnerabilityReporter.clearCache()
    const config = new Config({
      iast: iastConfig
    })
    iast.enable(config)
    rewriter.enable(config)
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
    .assertSomeTraces(traces => {
      if (traces[0][0].type !== 'web') throw new Error('Not a web span')
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

function checkVulnerabilityInRequest (
  vulnerability,
  occurrencesAndLocation,
  cb,
  makeRequest,
  config,
  done,
  matchLocation
) {
  let location
  let occurrences = occurrencesAndLocation
  if (occurrencesAndLocation !== null && typeof occurrencesAndLocation === 'object') {
    location = occurrencesAndLocation.location
    occurrences = occurrencesAndLocation.occurrences
  }
  agent
    .assertSomeTraces(traces => {
      expect(traces[0][0].metrics['_dd.iast.enabled']).to.be.equal(1)
      expect(traces[0][0].meta).to.have.property('_dd.iast.json')

      const span = getWebSpan(traces)
      assert.property(span.meta_struct, '_dd.stack')

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

      if (matchLocation) {
        const matchFound = locationHasMatchingFrame(span, vulnerability, vulnerabilitiesTrace.vulnerabilities)

        assert.isTrue(matchFound)
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
      rewriter.disable()
      app = null
    })

    after(() => {
      appListener && appListener.close()
      return agent.close({ ritmReset: false })
    })

    function testThatRequestHasVulnerability (
      fn,
      vulnerability,
      occurrences,
      cb,
      makeRequest,
      description,
      matchLocation = true
    ) {
      it(description || `should have ${vulnerability} vulnerability`, function (done) {
        this.timeout(5000)
        app = fn
        checkVulnerabilityInRequest(vulnerability, occurrences, cb, makeRequest, config, done, matchLocation)
      })
    }

    function testThatRequestHasNoVulnerability (fn, vulnerability, makeRequest, description) {
      it(description || `should not have ${vulnerability} vulnerability`, function (done) {
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

      if (loadMiddlewares) loadMiddlewares(expressApp, listener)

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
      rewriter.disable()
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

function prepareTestServerForIastInFastify (description, fastifyVersion, tests, iastConfig) {
  describe(description, () => {
    const config = {}
    let app, server

    before(function () {
      return agent.load(['fastify', 'http'], { client: false }, { flushInterval: 1 })
    })

    before(async () => {
      const fastify = require(`../../../../../versions/fastify@${fastifyVersion}`).get()
      const fastifyApp = fastify()

      fastifyApp.all('/', (request, reply) => {
        const headersSent = () => {
          if (reply.raw && typeof reply.raw.headersSent !== 'undefined') {
            return reply.raw.headersSent
          }
          // Fastify <3: use reply.sent
          return reply.sent === true
        }

        try {
          const result = app && app(request, reply.raw)

          const finish = () => {
            if (!headersSent()) {
              reply.code(200).send()
            }
          }

          if (result && typeof result.then === 'function') {
            result.then(finish).catch(() => finish())
          } else {
            finish()
          }
        } catch (e) {
          if (!headersSent()) {
            reply.code(500).send()
          } else if (reply.raw && typeof reply.raw.end === 'function') {
            reply.raw.end()
          }
        }
      })

      await fastifyApp.listen({ port: 0 })

      server = fastifyApp.server
      config.port = server.address().port
    })

    beforeEachIastTest(iastConfig)

    afterEach(() => {
      iast.disable()
      rewriter.disable()
      app = null
    })

    after(() => {
      server?.close()
      return agent?.close({ ritmReset: false })
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

function locationHasMatchingFrame (span, vulnerabilityType, vulnerabilities) {
  const stack = msgpack.decode(span.meta_struct['_dd.stack'])
  const matchingVulns = vulnerabilities.filter(vulnerability => vulnerability.type === vulnerabilityType)

  for (const vulnerability of stack.vulnerability) {
    for (const frame of vulnerability.frames) {
      for (const { location } of matchingVulns) {
        if (
          frame.line === location.line &&
          frame.class_name === location.class &&
          frame.function === location.method &&
          frame.path === location.path &&
          !location.hasOwnProperty('column')
        ) {
          return true
        }
      }
    }
  }

  return false
}

module.exports = {
  testOutsideRequestHasVulnerability,
  testInRequest,
  copyFileToTmp,
  prepareTestServerForIast,
  prepareTestServerForIastInExpress,
  prepareTestServerForIastInFastify
}
