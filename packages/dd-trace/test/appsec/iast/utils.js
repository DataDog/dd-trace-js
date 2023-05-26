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

  beforeEach((done) => {
    getPort().then(newPort => {
      config.port = newPort
      done()
    }, err => done(err))
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

  beforeEach((done) => {
    agent.load('http', undefined, { flushInterval: 1 })
      .then(() => {
        http = require('http')
        done()
      }, err => done(err))
  })

  beforeEach(done => {
    const server = new http.Server(listener)
    server.on('error', err => done(err))
    appListener = server
      .listen(config.port, 'localhost', () => done())
  })

  afterEach((done) => {
    appListener && appListener.close()
    agent.close({ ritmReset: false }).then(() => done(), e => done(e))
  })

  tests(config)
}

function testOutsideRequestHasVulnerability (fnToTest, vulnerability) {
  beforeEach((done) => {
    agent.load().then(() => done(), err => done(err))
  })

  afterEach((done) => {
    agent.close({ ritmReset: false }).then(() => done(), err => done(err))
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
      console.time('getPort()')
      return getPort().then(newPort => {
        config.port = newPort
        console.timeEnd('getPort()')
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

    before((done) => {
      console.time('agent.load()')
      agent.load('http', undefined, { flushInterval: 1 })
        .then(() => {
          http = require('http')
          done()
          console.timeEnd('agent.load()')
        }, err => done(err))
    })

    before(done => {
      console.time('server.listen()')
      const server = new http.Server(listener)
      appListener = server
        .listen(config.port, 'localhost', () => {
          done()
          console.timeEnd('server.listen()')
        })
    })

    beforeEach(() => {
      console.time('vulnerabilityReporter.clearCache()')
      vulnerabilityReporter.clearCache()
      console.timeEnd('vulnerabilityReporter.clearCache()')
    })

    beforeEach(() => {
      console.time('iast.enable')
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100,
            maxConcurrentRequests: 100,
            maxContextOperations: 100
          }
        }
      }))
      console.timeEnd('iast.enable')
    })

    afterEach(() => {
      console.time('iast.disable()')
      iast.disable()
      app = null
      console.timeEnd('iast.disable()')
    })

    after(() => {
      console.time('agent.close()')
      appListener && appListener.close()
      return agent.close({ ritmReset: false }).then(() => console.timeEnd('agent.close()'))
    })

    function testThatRequestHasVulnerability (fn, vulnerability, { occurrences, location } = {}) {
      it(`should have ${vulnerability} vulnerability`, function (done) {
        console.time(`should have ${vulnerability} vulnerability`)
        this.timeout(5000)
        app = fn
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.have.property('_dd.iast.json')
            const vulnerabilitiesTrace = JSON.parse(traces[0][0].meta['_dd.iast.json'])
            expect(vulnerabilitiesTrace).to.not.be.null
            const vulnerabilitiesCount = new Map()
            vulnerabilitiesTrace.vulnerabilities.forEach(v => {
              let count = vulnerabilitiesCount.get(v.type) || 0
              vulnerabilitiesCount.set(v.type, ++count)
            })

            expect(vulnerabilitiesCount.get(vulnerability)).to.not.be.null

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
            console.timeEnd(`should have ${vulnerability} vulnerability`)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`).catch(done)
      })
    }

    function testThatRequestHasNoVulnerability (fn, vulnerability) {
      it(`should not have ${vulnerability} vulnerability`, function (done) {
        console.time(`should not have ${vulnerability} vulnerability`)
        app = fn
        agent
          .use(traces => {
            // iastJson == undefiend is valid
            const iastJson = traces[0][0].meta['_dd.iast.json'] || ''
            expect(iastJson).to.not.include(`"${vulnerability}"`)
            console.timeEnd(`should not have ${vulnerability} vulnerability`)
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
