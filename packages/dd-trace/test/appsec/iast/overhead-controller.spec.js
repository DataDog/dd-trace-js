const overheadController = require('../../../src/appsec/iast/overhead-controller')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
const DatadogSpanContext = require('../../../src/opentracing/span_context')
const Config = require('../../../src/config')
const id = require('../../../src/id')
const iast = require('../../../src/appsec/iast')
const { testInRequest } = require('./utils')
const agent = require('../../plugins/agent')
const axios = require('axios')
const dc = require('diagnostics_channel')

describe('Overhead controller', () => {
  const oceContextKey = overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY

  describe('unit tests', () => {
    beforeEach(() => {
      const config = new Config({
        experimental: {
          iast: true
        }
      })
      overheadController.configure(config.iast)
      overheadController._resetGlobalContext()
    })

    describe('Initialize OCE context', () => {
      describe('Request context', () => {
        it('should not fail when no context is provided', () => {
          overheadController.initializeRequestContext()
        })

        it('should populate request context', () => {
          const iastContext = {}
          overheadController.initializeRequestContext(iastContext)
          expect(iastContext).to.have.nested.property(overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY)
        })
      })
    })

    describe('Analyze request', () => {
      it('should allow requests which span id ends with a smaller number than default 30', () => {
        const rootSpan = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972427', 10)
          }))
        }

        const reserved = overheadController.acquireRequest(rootSpan)
        expect(reserved).to.be.true
      })

      it('should allow requests which span id ends with a default 30', () => {
        const rootSpan = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972430', 10)
          }))
        }

        const reserved = overheadController.acquireRequest(rootSpan)
        expect(reserved).to.be.true
      })

      it('should not allow requests which span id ends with a bigger number than default 30', () => {
        const rootSpan = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972431', 10)
          }))
        }

        const reserved = overheadController.acquireRequest(rootSpan)
        expect(reserved).to.be.false
      })

      it('should allow a maximum of 2 request at same time', () => {
        const rootSpan1 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972418', 10)
          }))
        }
        const rootSpan2 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972417', 10)
          }))
        }
        const rootSpan3 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972416', 10)
          }))
        }

        const reserved1 = overheadController.acquireRequest(rootSpan1)
        const reserved2 = overheadController.acquireRequest(rootSpan2)
        const reserved3 = overheadController.acquireRequest(rootSpan3)
        expect(reserved1).to.be.true
        expect(reserved2).to.be.true
        expect(reserved3).to.be.false
      })

      it('should release a request', () => {
        const rootSpan1 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972418', 10)
          }))
        }
        const rootSpan2 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972417', 10)
          }))
        }
        const rootSpan3 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972416', 10)
          }))
        }
        const rootSpan4 = {
          context: sinon.stub().returns(new DatadogSpanContext({
            spanId: id('6004358438913972429', 10)
          }))
        }

        const reserved1 = overheadController.acquireRequest(rootSpan1)
        const reserved2 = overheadController.acquireRequest(rootSpan2)
        const reserved3 = overheadController.acquireRequest(rootSpan3)
        overheadController.releaseRequest()
        const reserved4 = overheadController.acquireRequest(rootSpan4)
        expect(reserved1).to.be.true
        expect(reserved2).to.be.true
        expect(reserved3).to.be.false
        expect(reserved4).to.be.true
      })
    })

    describe('Operations', () => {
      describe('Report vulnerability', () => {
        let iastContext
        const OPERATION = overheadController.OPERATIONS.REPORT_VULNERABILITY

        it('should not fail with unexpected data', () => {
          overheadController.hasQuota(OPERATION)
          overheadController.hasQuota(OPERATION, null)
          overheadController.hasQuota(OPERATION, {})
        })

        describe('within request', () => {
          beforeEach(() => {
            iastContext = {}
            overheadController.initializeRequestContext(iastContext)
          })

          it('should populate initial context with available tokens', () => {
            expect(iastContext[oceContextKey])
              .to.have.nested.property(`tokens.${OPERATION.name}`, OPERATION.initialTokenBucketSize())
          })

          it('should allow when available tokens', () => {
            iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 2
            expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.true
            expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 1)
          })

          it('should not allow when no available tokens', () => {
            iastContext[overheadController.OVERHEAD_CONTROLLER_CONTEXT_KEY].tokens[OPERATION.name] = 0
            expect(overheadController.hasQuota(OPERATION, iastContext)).to.be.false
            expect(iastContext[oceContextKey]).to.have.nested.property(`tokens.${OPERATION.name}`, 0)
          })
        })

        describe('out of request', () => {
          it('should reject the operation once all tokens has been spent', () => {
            for (let i = 0, l = OPERATION.initialTokenBucketSize(); i < l; i++) {
              expect(overheadController.hasQuota(OPERATION, {})).to.be.true
            }
            expect(overheadController.hasQuota(OPERATION, {})).to.be.false
          })
        })
      })
    })
  })
  describe('full feature', () => {
    describe('multiple request at same time', () => {
      const requestStartedChannel = dc.channel('overhead-controller:test:request:started')
      const finishRequestChannel = dc.channel('overhead-controller:test:request:finish')
      function app (req) {
        return new Promise((resolve) => {
          requestStartedChannel.publish(req)
          const crypto = require('crypto')
          crypto.createHash('sha1')
          const resolvePromise = (channelData) => {
            if (req.url.includes(channelData.url)) {
              finishRequestChannel.unsubscribe(resolvePromise)
              resolve()
            }
          }
          finishRequestChannel.subscribe(resolvePromise)
          // setTimeout(() => {
          //   resolve()
          // }, 500)
        })
      }

      function tests (serverConfig) {
        const handlers = []

        afterEach(() => {
          handlers.forEach(agent.unsubscribe)
          handlers.splice(0)
        })

        afterEach(() => {
          vulnerabilityReporter.clearCache()
          iast.disable()
        })

        function twoRequestInParallel (done) {
          const firstRequestHandler = function (req) {
            if (req.url.includes('/one')) {
              requestStartedChannel.unsubscribe(firstRequestHandler)
              const secondRequestHandler = function (req) {
                requestStartedChannel.unsubscribe(secondRequestHandler)
                if (req.url.includes('/two')) {
                  finishRequestChannel.publish({ url: '/one' })
                }
              }
              requestStartedChannel.subscribe(secondRequestHandler)
              axios.get(`http://localhost:${serverConfig.port}/two`).catch(done)
            }
          }
          requestStartedChannel.subscribe(firstRequestHandler)
          axios.get(`http://localhost:${serverConfig.port}/one`).then(() => {
            vulnerabilityReporter.clearCache()
            finishRequestChannel.publish({ url: '/two' })
          }).catch(done)
        }

        it('should detect vulnerabilities only in one if max concurrent is 1', (done) => {
          const config = new Config({
            experimental: {
              iast: {
                enabled: true,
                requestSampling: 100,
                maxConcurrentRequests: 1
              }
            }
          })
          iast.enable(config)
          let urlCounter = 0
          const handler = function (traces) {
            try {
              for (let i = 0; i < traces.length; i++) {
                for (let j = 0; j < traces[i].length; j++) {
                  const trace = traces[i][j]
                  if (trace.name === 'web.request') {
                    const url = trace.meta['http.url']
                    if (url.includes('/one')) {
                      expect(trace.meta['_dd.iast.json']).not.to.be.undefined
                      urlCounter++
                    } else if (url.includes('/two')) {
                      expect(trace.meta['_dd.iast.json']).to.be.undefined
                      urlCounter++
                    }
                    if (urlCounter === 2) {
                      done()
                    }
                  }
                }
              }
            } catch (e) {
              agent.unsubscribe(handler)
              done(e)
            }
          }
          handlers.push(handler)
          agent.subscribe(handler)
          twoRequestInParallel(done)
        })

        it('should detect vulnerabilities in both if max concurrent is 2', (done) => {
          const config = new Config({
            experimental: {
              iast: {
                enabled: true,
                requestSampling: 100,
                maxConcurrentRequests: 2
              }
            }
          })
          iast.enable(config)
          let urlCounter = 0
          const handler = function (traces) {
            try {
              for (let i = 0; i < traces.length; i++) {
                for (let j = 0; j < traces[i].length; j++) {
                  const trace = traces[i][j]
                  if (trace.name === 'web.request') {
                    urlCounter++
                    expect(trace.meta['_dd.iast.json']).not.to.be.undefined
                    if (urlCounter === 2) {
                      done()
                    }
                  }
                }
              }
            } catch (e) {
              agent.unsubscribe(handler)
              done(e)
            }
          }
          handlers.push(handler)
          agent.subscribe(handler)
          twoRequestInParallel(done)
        })

        it('should recovery requests budget', function (done) {
          // 3 in parallel => 2 detects - 1 not detects
          // on finish the first => launch 2 - should detect 1 more
          const config = new Config({
            experimental: {
              iast: {
                enabled: true,
                requestSampling: 100,
                maxConcurrentRequests: 2
              }
            }
          })
          iast.enable(config)

          let counter = 0
          const handler = function (traces) {
            try {
              for (let i = 0; i < traces.length; i++) {
                for (let j = 0; j < traces[i].length; j++) {
                  const trace = traces[i][j]
                  if (trace.name === 'web.request') {
                    counter++
                    const url = trace.meta['http.url']
                    if (url.includes('/one')) {
                      expect(trace.meta['_dd.iast.json']).not.to.be.undefined
                    } else if (url.includes('/two')) {
                      expect(trace.meta['_dd.iast.json']).not.to.be.undefined
                    } else if (url.includes('/three')) {
                      expect(trace.meta['_dd.iast.json']).to.be.undefined
                    } else if (url.includes('/four')) {
                      expect(trace.meta['_dd.iast.json']).not.to.be.undefined
                    } else if (url.includes('/five')) {
                      expect(trace.meta['_dd.iast.json']).to.be.undefined
                    }
                    counter === 5 && done()
                  }
                }
              }
            } catch (e) {
              agent.unsubscribe(handler)
              done(e)
            }
          }
          handlers.push(handler)
          agent.subscribe(handler)

          const fifthRequestHandler = function (req) {
            // TODO finish /two request
            if (req.url.includes('/five')) {
              requestStartedChannel.unsubscribe(fifthRequestHandler)
              finishRequestChannel.publish({ url: '/two' })
            }
          }

          const fourthRequestHandler = function (req) {
            if (req.url.includes('/four')) {
              requestStartedChannel.unsubscribe(fourthRequestHandler)
              requestStartedChannel.subscribe(fifthRequestHandler)
              // must detect, second request, has budget
              axios.get(`http://localhost:${serverConfig.port}/five`).catch(done)
            }
          }

          const thirdRequestHandler = function (req) {
            if (req.url.includes('/three')) {
              requestStartedChannel.unsubscribe(thirdRequestHandler)
              finishRequestChannel.publish({ url: '/one' })
            }
          }

          const secondRequestHandler = function (req) {
            if (req.url.includes('/two')) {
              requestStartedChannel.unsubscribe(secondRequestHandler)
              requestStartedChannel.subscribe(thirdRequestHandler)
              // can't detect, third request in parallel, max 2
              axios.get(`http://localhost:${serverConfig.port}/three`)
                .then(() => {
                  vulnerabilityReporter.clearCache()
                  finishRequestChannel.publish({ url: '/four' })
                })
                .catch(done)
            }
          }

          const firstRequestHandler = function (req) {
            if (req.url.includes('/one')) {
              requestStartedChannel.unsubscribe(firstRequestHandler)
              requestStartedChannel.subscribe(secondRequestHandler)
              // must detect, second request, has budget
              axios.get(`http://localhost:${serverConfig.port}/two`).then(() => {
                vulnerabilityReporter.clearCache()
                finishRequestChannel.publish({ url: '/three' })
              }).catch(done)
            }
          }

          requestStartedChannel.subscribe(firstRequestHandler)
          // must detect, first request, nothing in parallel
          axios.get(`http://localhost:${serverConfig.port}/one`).then(() => {
            vulnerabilityReporter.clearCache()
            // first request finished, current status: 1 running with IAST and 1 running without IAST
            // 1 free slot for IAST
            requestStartedChannel.subscribe(fourthRequestHandler)
            axios.get(`http://localhost:${serverConfig.port}/four`)
              .then(() => {
                vulnerabilityReporter.clearCache()
                finishRequestChannel.publish({ url: '/five' })
              })
          }).catch(done)
        })
      }
      testInRequest(app, tests)
    })
  })
})
