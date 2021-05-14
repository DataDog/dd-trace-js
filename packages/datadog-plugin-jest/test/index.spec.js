'use strict'
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { expect } = require('chai')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME: TEST_NAME_TAG,
  TEST_SUITE: TEST_SUITE_TAG,
  TEST_STATUS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  TEST_PARAMETERS
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', () => {
  let tracer
  let DatadogJestEnvironment
  let datadogJestEnv
  const TEST_NAME = 'test_name'
  const TEST_SUITE = 'test-file.js'
  const BUILD_SOURCE_ROOT = '/source-root'

  withVersions(plugin, ['jest-environment-node', 'jest-environment-jsdom'], (version, moduleName) => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      tracer = require('../../dd-trace')
      return agent.load('jest').then(() => {
        DatadogJestEnvironment = require(`../../../versions/${moduleName}@${version}`).get()
        datadogJestEnv = new DatadogJestEnvironment({ rootDir: BUILD_SOURCE_ROOT }, { testPath: TEST_SUITE })
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

    describe('jest', () => {
      it('should create a test span for a passing test', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
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
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
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
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: TEST_NAME,
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
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
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
      })

      it('should not call wrap on events other than test_start or test_skip', () => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
        tracer._tracer.wrap = sinon.spy(() => {})

        const testFnStartEvent = {
          name: 'test_fn_start'
        }
        datadogJestEnv.handleTestEvent(testFnStartEvent)
        expect(tracer._tracer.wrap).not.to.have.been.called
      })

      it('should call startSpan and span finish on skipped tests', () => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
        const span = { finish: sinon.spy(() => {}) }
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
      })

      it('should call flush on teardown', async () => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
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
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return
        expect(datadogJestEnv.testSuite).to.equal(TEST_SUITE)
      })

      it('does not crash with an empty context and uses test name from event', (done) => {
        const TEST_NAME_FROM_EVENT = `${TEST_NAME}_FROM_EVENT`

        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
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

      it('should work with parameterized tests', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

      it('should detect timeouts as failed tests', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        const testStartEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            name: TEST_NAME
          }
        }
        datadogJestEnv.handleTestEvent(testStartEvent)
        testStartEvent.test.fn()

        const timedoutTestEvent = {
          name: 'test_fn_failure',
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

      it('should not consider other errors as timeout', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
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
