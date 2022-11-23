'use strict'

require('../../../../dd-trace/test/setup/tap')

const overheadController = require('../../../src/appsec/iast/overhead-controller')
// const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
const DatadogSpanContext = require('../../../src/opentracing/span_context')
const Config = require('../../../src/config')
const id = require('../../../src/id')
// const iast = require('../../../src/appsec/iast')
// const { testInRequest } = require('./utils')
// const agent = require('../../plugins/agent')
// const axios = require('axios')
// const { EventEmitter } = require('events')

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
      // const TEST_REQUEST_STARTED = 'test-request-started'
      // const TEST_REQUEST_FINISHED = 'test-request-finished'

      // const FIRST_REQUEST = '/first'
      // const SECOND_REQUEST = '/second'
      // const THIRD_REQUEST = '/third'
      // const FOURTH_REQUEST = '/fourth'
      // const FIFTH_REQUEST = '/fifth'

      // const testRequestEventEmitter = new EventEmitter()
      // let requestResolvers = {}

      // function app (req) {
      //   return new Promise((resolve) => {
      //     const crypto = require('crypto')
      //     crypto.createHash('sha1')
      //     requestResolvers[req.url] = () => {
      //       resolve()
      //       testRequestEventEmitter.emit(TEST_REQUEST_FINISHED, req.url)
      //     }
      //     testRequestEventEmitter.emit(TEST_REQUEST_STARTED, req.url)
      //   })
      // }

      // function tests (serverConfig) {
      //   const handlers = []

      //   beforeEach(() => {
      //     testRequestEventEmitter
      //       .removeAllListeners(TEST_REQUEST_STARTED)
      //       .removeAllListeners(TEST_REQUEST_FINISHED)
      //     requestResolvers = {}
      //   })

      //   afterEach(() => {
      //     handlers.forEach(agent.unsubscribe)
      //     handlers.splice(0)
      //   })

      //   afterEach(() => {
      //     vulnerabilityReporter.clearCache()
      //     iast.disable()
      //   })

      //   it('should detect vulnerabilities only in one if max concurrent is 1', (done) => {
      //     const config = new Config({
      //       experimental: {
      //         iast: {
      //           enabled: true,
      //           requestSampling: 100,
      //           maxConcurrentRequests: 1
      //         }
      //       }
      //     })
      //     iast.enable(config)
      //     let urlCounter = 0
      //     const handler = function (traces) {
      //       try {
      //         for (let i = 0; i < traces.length; i++) {
      //           for (let j = 0; j < traces[i].length; j++) {
      //             const trace = traces[i][j]
      //             if (trace.type === 'web') {
      //               const url = trace.meta['http.url']
      //               if (url.includes(FIRST_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).not.to.be.undefined
      //                 urlCounter++
      //               } else if (url.includes(SECOND_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).to.be.undefined
      //                 urlCounter++
      //               }
      //               if (urlCounter === 2) {
      //                 done()
      //               }
      //             }
      //           }
      //         }
      //       } catch (e) {
      //         agent.unsubscribe(handler)
      //         done(e)
      //       }
      //     }
      //     handlers.push(handler)
      //     agent.subscribe(handler)
      //     testRequestEventEmitter.on(TEST_REQUEST_STARTED, (url) => {
      //       if (url === FIRST_REQUEST) {
      //         axios.get(`http://localhost:${serverConfig.port}${SECOND_REQUEST}`).then().catch(done)
      //       } else if (url === SECOND_REQUEST) {
      //         requestResolvers[FIRST_REQUEST]()
      //         requestResolvers[SECOND_REQUEST]()
      //       }
      //     })
      //     axios.get(`http://localhost:${serverConfig.port}${FIRST_REQUEST}`).then().catch(done)
      //   })

      //   it('should detect vulnerabilities in both if max concurrent is 2', (done) => {
      //     const config = new Config({
      //       experimental: {
      //         iast: {
      //           enabled: true,
      //           requestSampling: 100,
      //           maxConcurrentRequests: 2
      //         }
      //       }
      //     })
      //     iast.enable(config)
      //     let urlCounter = 0
      //     const handler = function (traces) {
      //       try {
      //         for (let i = 0; i < traces.length; i++) {
      //           for (let j = 0; j < traces[i].length; j++) {
      //             const trace = traces[i][j]
      //             if (trace.type === 'web') {
      //               urlCounter++
      //               expect(trace.meta['_dd.iast.json']).not.to.be.undefined
      //               if (urlCounter === 2) {
      //                 done()
      //               }
      //             }
      //           }
      //         }
      //       } catch (e) {
      //         agent.unsubscribe(handler)
      //         done(e)
      //       }
      //     }
      //     handlers.push(handler)
      //     agent.subscribe(handler)
      //     testRequestEventEmitter.on(TEST_REQUEST_STARTED, (url) => {
      //       if (url === FIRST_REQUEST) {
      //         axios.get(`http://localhost:${serverConfig.port}${SECOND_REQUEST}`).then().catch(done)
      //       } else if (url === SECOND_REQUEST) {
      //         setImmediate(() => {
      //           requestResolvers[FIRST_REQUEST]()
      //           vulnerabilityReporter.clearCache()
      //         })
      //       }
      //     })
      //     testRequestEventEmitter.on(TEST_REQUEST_FINISHED, (url) => {
      //       if (url === FIRST_REQUEST) {
      //         setImmediate(() => {
      //           requestResolvers[SECOND_REQUEST]()
      //           vulnerabilityReporter.clearCache()
      //         })
      //       }
      //     })
      //     axios.get(`http://localhost:${serverConfig.port}${FIRST_REQUEST}`).then().catch(done)
      //   })

      //   it('should recovery requests budget', function (done) {
      //     // 3 in parallel => 2 detects - 1 not detects
      //     // on finish the first => launch 2 - should detect 1 more
      //     const config = new Config({
      //       experimental: {
      //         iast: {
      //           enabled: true,
      //           requestSampling: 100,
      //           maxConcurrentRequests: 2
      //         }
      //       }
      //     })
      //     iast.enable(config)

      //     let counter = 0
      //     const handler = function (traces) {
      //       try {
      //         for (let i = 0; i < traces.length; i++) {
      //           for (let j = 0; j < traces[i].length; j++) {
      //             const trace = traces[i][j]
      //             if (trace.type === 'web') {
      //               counter++
      //               const url = trace.meta['http.url']
      //               if (url.includes(FIRST_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).not.to.be.undefined
      //               } else if (url.includes(SECOND_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).not.to.be.undefined
      //               } else if (url.includes(THIRD_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).to.be.undefined
      //               } else if (url.includes(FOURTH_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).not.to.be.undefined
      //               } else if (url.includes(FIFTH_REQUEST)) {
      //                 expect(trace.meta['_dd.iast.json']).to.be.undefined
      //               }
      //               counter === 5 && done()
      //             }
      //           }
      //         }
      //       } catch (e) {
      //         agent.unsubscribe(handler)
      //         done(e)
      //       }
      //     }
      //     handlers.push(handler)
      //     agent.subscribe(handler)

      //     testRequestEventEmitter.on(TEST_REQUEST_STARTED, (url) => {
      //       if (url === FIRST_REQUEST) {
      //         axios.get(`http://localhost:${serverConfig.port}${SECOND_REQUEST}`).then().catch(done)
      //       } else if (url === SECOND_REQUEST) {
      //         axios.get(`http://localhost:${serverConfig.port}${THIRD_REQUEST}`).then().catch(done)
      //       } else if (url === THIRD_REQUEST) {
      //         requestResolvers[FIRST_REQUEST]()
      //       } else if (url === FIFTH_REQUEST) {
      //         requestResolvers[SECOND_REQUEST]()
      //         vulnerabilityReporter.clearCache()
      //       }
      //     })
      //     testRequestEventEmitter.on(TEST_REQUEST_FINISHED, (url) => {
      //       if (url === FIRST_REQUEST) {
      //         axios.get(`http://localhost:${serverConfig.port}${FOURTH_REQUEST}`).then().catch(done)
      //         axios.get(`http://localhost:${serverConfig.port}${FIFTH_REQUEST}`).then().catch(done)
      //       } else if (url === SECOND_REQUEST) {
      //         setImmediate(() => {
      //           vulnerabilityReporter.clearCache()
      //           requestResolvers[THIRD_REQUEST]()
      //           requestResolvers[FOURTH_REQUEST]()
      //           requestResolvers[FIFTH_REQUEST]()
      //         })
      //       }
      //     })

      //     axios.get(`http://localhost:${serverConfig.port}${FIRST_REQUEST}`).then().catch(done)
      //   })
      // }

      // testInRequest(app, tests) // TODO: re-enable when fixed with tap
    })
  })
})
