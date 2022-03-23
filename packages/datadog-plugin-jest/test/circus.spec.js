'use strict'
const nock = require('nock')

const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME: TEST_NAME_TAG,
  TEST_SUITE: TEST_SUITE_TAG,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  TEST_PARAMETERS,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', function () {
  let tracer
  let DatadogJestEnvironment
  let datadogJestEnv
  const TEST_NAME = 'test_name'
  const TEST_SUITE = 'test-file.js'
  const BUILD_SOURCE_ROOT = '/source-root'

  this.timeout(5000)

  withVersions(plugin, ['jest-environment-node', 'jest-environment-jsdom'], (version, moduleName) => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      tracer = require('../../dd-trace')
      return agent.load(['jest', 'fs', 'http'], { service: 'test' }).then(() => {
        DatadogJestEnvironment = require(`../../../versions/${moduleName}@${version}`).get()
        datadogJestEnv = new DatadogJestEnvironment({
          rootDir: BUILD_SOURCE_ROOT,
          testEnvironmentOptions: { userAgent: null }
        }, { testPath: `${BUILD_SOURCE_ROOT}/${TEST_SUITE}` })
        // TODO: avoid mocking expect once we instrument the runner instead of the environment
        datadogJestEnv.getVmContext = () => ({
          expect: {
            getState: () =>
              ({
                currentTestName: TEST_NAME
              })
          }
        })
      })
    })
    describe('jest with http', () => {
      it('works with http integration', (done) => {
        agent
          .use(trace => {
            const testSpan = trace[0].find(span => span.type === 'test')
            const httpSpan = trace[0].find(span => span.name === 'http.request')
            expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(httpSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {
              const http = require('http')
              http.request('http://test:123')
            },
            name: TEST_NAME
          }
        }

        datadogJestEnv.handleTestEvent(passingTestEvent)
        passingTestEvent.test.fn()
      })
    })
    describe('jest with jest-circus', () => {
      it('should create a test span for a passing test', (done) => {
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
              [TEST_STATUS]: 'pass',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME}`)
            expect(traces[0][0].service).to.equal('test')
            expect(traces[0][0].meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }

        // jest calls this with `event.name: 'test_start'` before the test starts
        datadogJestEnv.handleTestEvent(passingTestEvent)
        // we call the test function, just like jest does
        passingTestEvent.test.fn()
      })

      it('should create a test span for a failing test', (done) => {
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test',
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'custom error message'
            })
            expect(traces[0][0].meta[ERROR_STACK]).not.to.be.undefined
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

        const failingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {
              throw Error('custom error message')
            },
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(failingTestEvent)
        failingTestEvent.test.fn()
      })

      it('should create a test span for a skipped test', (done) => {
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_STATUS]: 'skip',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

        const skippedTestEvent = {
          name: 'test_skip',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(skippedTestEvent)
        skippedTestEvent.test.fn()
      })

      it('should create a test span for an async test', (done) => {
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
              [TEST_STATUS]: 'pass',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

        const asyncTestEvent = {
          name: 'test_start',
          test: {
            fn: async () => {
              await new Promise(resolve => {
                setTimeout(resolve, 100)
              })
            },
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(asyncTestEvent)
        asyncTestEvent.test.fn()
      })

      it('should call wrap on test_start event', () => {
        const originalWrap = tracer._tracer.wrap
        tracer._tracer.wrap = sinon.spy(() => {})

        const testEvent = {
          name: 'test_start',
          test: {
            fn: async () => {
              await new Promise(resolve => {
                setTimeout(resolve, 100)
              })
            },
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(testEvent)
        expect(tracer._tracer.wrap).to.have.been.called
        tracer._tracer.wrap = originalWrap
      })

      it('should not call wrap on events other than test_start or test_skip', () => {
        const originalWrap = tracer._tracer.wrap
        tracer._tracer.wrap = sinon.spy(() => {})

        const testFnStartEvent = {
          name: 'test_fn_start'
        }
        datadogJestEnv.handleTestEvent(testFnStartEvent)
        expect(tracer._tracer.wrap).not.to.have.been.called
        tracer._tracer.wrap = originalWrap
      })

      it('should call startSpan and span finish on skipped tests', () => {
        const span = { finish: sinon.spy(() => {}), context: sinon.spy(() => ({ _trace: { origin: '' } })) }
        tracer._tracer.startSpan = sinon.spy(() => {
          return span
        })

        const skippedTestEvent = {
          name: 'test_skip',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(skippedTestEvent)
        skippedTestEvent.test.fn()
        expect(tracer._tracer.startSpan).to.have.been.called
        expect(span.finish).to.have.been.called
        expect(span.context).to.have.been.called
      })

      it('should call flush on teardown', async () => {
        tracer._tracer._exporter._writer.flush = sinon.spy((done) => {
          done()
        })
        const thisArg = {
          global: {
            close: () => {},
            test: {
              each: () => () => {}
            }
          }
        }
        await datadogJestEnv.teardown.call(thisArg)
        expect(tracer._tracer._exporter._writer.flush).to.have.been.called
      })

      it('should set testSuite on the constructor', () => {
        expect(datadogJestEnv.testSuite).to.equal(TEST_SUITE)
      })

      it('does not crash with an empty context and uses test name from event', (done) => {
        const TEST_NAME_FROM_EVENT = `${TEST_NAME}_FROM_EVENT`

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME_FROM_EVENT,
              [TEST_STATUS]: 'pass',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME_FROM_EVENT}`)
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME_FROM_EVENT
          }
        }
        datadogJestEnv.getVmContext = () => null
        datadogJestEnv.handleTestEvent(passingTestEvent)
        passingTestEvent.test.fn()
      })

      it('should work with tests parameterized through an array', (done) => {
        const tracer = require('../../dd-trace')
        sinon.spy(tracer._instrumenter, 'wrap')

        const setupEvent = {
          name: 'setup'
        }

        const thisArg = {
          global: {
            test: {
              each: () => () => {}
            }
          }
        }

        datadogJestEnv.handleTestEvent.call(thisArg, setupEvent)
        expect(tracer._instrumenter.wrap).to.have.been.calledWith(thisArg.global.test, 'each')
        thisArg.global.test.each([[{ parameterA: 'a' }]])('test-name')
        tracer._instrumenter.wrap.restore()

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              [TEST_PARAMETERS]: JSON.stringify({ arguments: [{ parameterA: 'a' }], metadata: {} })
            })
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: 'test-name'
          }
        }
        datadogJestEnv.handleTestEvent(passingTestEvent)
        passingTestEvent.test.fn()
      })

      it('should work with tests parameterized through a string', (done) => {
        const setupEvent = {
          name: 'setup'
        }

        const thisArg = {
          global: {
            test: {
              each: () => () => {}
            }
          }
        }

        datadogJestEnv.handleTestEvent.call(thisArg, setupEvent)
        thisArg.global.test.each(['\n    a    | b    | expected\n    '], 1, 2, 3)('test-name')
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              [TEST_PARAMETERS]: JSON.stringify({
                arguments: { a: 1, b: 2, expected: 3 }, metadata: {}
              })
            })
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: 'test-name'
          }
        }
        datadogJestEnv.handleTestEvent(passingTestEvent)
        passingTestEvent.test.fn()
      })

      it('should detect timeouts as failed tests', (done) => {
        const testStartEvent = {
          name: 'test_start',
          test: {
            invocations: 1,
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        const timedoutTestEvent = {
          name: 'test_fn_failure',
          test: {
            invocations: 1
          },
          error: 'Exceeded timeout of 100ms'
        }
        datadogJestEnv.handleTestEvent(timedoutTestEvent)

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              [ERROR_TYPE]: 'Timeout',
              [ERROR_MESSAGE]: 'Exceeded timeout of 100ms'
            })
          }).then(done).catch(done)
      })

      it('should work with timed out retries', (done) => {
        const testStartEvent = {
          name: 'test_start',
          test: {
            invocations: 1,
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        const timedoutTestEvent = {
          name: 'test_fn_failure',
          test: {
            invocations: 1
          },
          error: 'Exceeded timeout of 100ms'
        }
        datadogJestEnv.handleTestEvent(timedoutTestEvent)

        const testRetryEvent = {
          name: 'test_retry',
          test: {
            invocations: 1,
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(testRetryEvent)

        testStartEvent.test.invocations++
        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        agent.use(trace => {
          const failedTest = trace[0].find(span => span.meta[TEST_STATUS] === 'fail')
          const passedTest = trace[0].find(span => span.meta[TEST_STATUS] === 'pass')
          expect(failedTest.meta).to.contain({
            [TEST_STATUS]: 'fail',
            [ERROR_TYPE]: 'Timeout',
            [ERROR_MESSAGE]: 'Exceeded timeout of 100ms'
          })
          expect(passedTest.meta).to.contain({
            [TEST_STATUS]: 'pass'
          })
        }).then(() => done()).catch(done)
      })

      it('should not consider other errors as timeout', (done) => {
        const testStartEvent = {
          name: 'test_start',
          test: {
            fn: () => {
              throw new Error('non timeout error')
            },
            name: TEST_NAME
          }
        }

        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()
        const timedoutTestEvent = {
          name: 'test_fn_failure',
          error: new Error('other error')
        }
        const thisArg = {
          getVmContext: sinon.spy()
        }
        datadogJestEnv.handleTestEvent.call(thisArg, timedoutTestEvent)
        expect(thisArg.getVmContext).not.to.have.been.called
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'non timeout error'
            })
          }).then(done).catch(done)
      })

      it('set _dd.origin=ciapp-test to the test span and all children spans', (done) => {
        agent
          .use(trace => {
            const testSpan = trace[0].find(span => span.type === 'test')
            const fsOperationSpans = trace[0].filter(span => span.name === 'fs.operation')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(fsOperationSpans.length > 1).to.equal(true)
            expect(fsOperationSpans.every(span => span.meta[ORIGIN_KEY] === CI_APP_ORIGIN)).to.equal(true)
            const fsReadFileSyncSpan = trace[0].find(span => span.resource === 'readFileSync')
            expect(fsReadFileSyncSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {
              const fs = require('fs')
              fs.readFileSync('./package.json')
            },
            name: TEST_NAME
          }
        }

        datadogJestEnv.handleTestEvent(passingTestEvent)
        passingTestEvent.test.fn()
      })

      it('should detect snapshot errors', (done) => {
        const testStartEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.getVmContext = () => ({
          expect: {
            getState: () =>
              ({
                currentTestName: TEST_NAME,
                suppressedErrors: [new Error('snapshot error message')]
              })
          }
        })

        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'snapshot error message'
            })
          }).then(done).catch(done)
      })

      it('handles errors in hooks', (done) => {
        const hookError = new Error('hook error')

        agent
          .use(trace => {
            const testSpan = trace[0].find(span => span.type === 'test')
            expect(testSpan.meta).to.contain({
              [TEST_STATUS]: 'fail',
              [TEST_TYPE]: 'test',
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'hook failure',
              [ERROR_STACK]: hookError.stack
            })
          }).then(done).catch(done)

        const hookFailureEvent = {
          name: 'hook_failure',
          test: {
            fn: () => {},
            name: TEST_NAME,
            errors: [[
              'hook failure',
              hookError
            ]]
          }
        }

        datadogJestEnv.handleTestEvent(hookFailureEvent)
      })

      it('does not crash when there is an error in a hook outside a test', (done) => {
        const hookFailureEvent = {
          name: 'hook_failure'
        }
        datadogJestEnv.handleTestEvent(hookFailureEvent).then(done).catch(done)
      })

      it('should not crash when getVmContext is not a function', (done) => {
        const testStartEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.getVmContext = undefined

        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        agent
          .use(traces => {
            expect(traces[0][0].meta[ERROR_TYPE]).to.be.undefined
            expect(traces[0][0].meta[TEST_NAME_TAG]).to.equal(TEST_NAME)
          }).then(done).catch(done)
      })

      // TODO: allow the plugin consumer to define their own jest's `testEnvironment`
      it.skip('should allow the customer to use their own environment', (done) => {
        class CustomerCustomEnv extends DatadogJestEnvironment {
          async handleTestEvent () {
            // do custom stuff
            return new Promise(resolve => {
              setTimeout(resolve, 100)
            })
          }
        }
        const customerTestEnv = new CustomerCustomEnv({ rootDir: BUILD_SOURCE_ROOT }, { testPath: TEST_SUITE })
        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE_TAG]: TEST_SUITE,
              [TEST_TYPE]: 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)
        const testEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        customerTestEnv.handleTestEvent(testEvent)
        testEvent.test.fn()
      })
    })
  })
})
