'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let DatadogJestEnvironment

  withVersions(plugin, 'jest-environment-node', version => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      agent.load('jest-environment-node').then(() => {
        DatadogJestEnvironment = require(`../../../versions/jest-environment-node@${version}`).get()
      })
    })

    describe('jest-environment-node', () => {
      const TEST_NAME = 'test_name'
      const TEST_SUITE = 'test-file.js'
      const BUILD_SOURCE_ROOT = '/source-root'
      const ROOT_TEST_SUITE = 'root'

      it('should create a test span for a passing test', (done) => {
        const datadogJestEnv = new DatadogJestEnvironment({ rootDir: BUILD_SOURCE_ROOT }, { testPath: TEST_SUITE })
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              'test.name': TEST_NAME,
              'test.status': 'pass',
              'test.suite': TEST_SUITE,
              'test.type': 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${ROOT_TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

        const passingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {},
            parent: {
              name: ROOT_TEST_SUITE
            },
            name: TEST_NAME
          }
        }

        // jest calls this with `event.name: 'test_start'` before the test starts
        datadogJestEnv.handleTestEvent(passingTestEvent)
        // we call the test function, just like jest does
        passingTestEvent.test.fn()
      })
      it('should create a test span for a failing test', (done) => {
        const datadogJestEnv = new DatadogJestEnvironment({ rootDir: BUILD_SOURCE_ROOT }, { testPath: TEST_SUITE })
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

        agent
          .use(traces => {
            expect(traces[0][0].meta).to.contain({
              language: 'javascript',
              service: 'test',
              'test.name': TEST_NAME,
              'test.status': 'fail',
              'test.suite': TEST_SUITE,
              'test.type': 'test'
            })
            expect(traces[0][0].type).to.equal('test')
            expect(traces[0][0].name).to.equal('jest.test')
            expect(traces[0][0].resource).to.equal(`${ROOT_TEST_SUITE}.${TEST_NAME}`)
          }).then(done).catch(done)

        const failingTestEvent = {
          name: 'test_start',
          test: {
            fn: () => {
              throw Error
            },
            parent: {
              name: ROOT_TEST_SUITE
            },
            name: TEST_NAME
          }
        }
        // jest calls this with `event.name: 'test_start'` before the test starts
        datadogJestEnv.handleTestEvent(failingTestEvent)
        // we call the test function, just like jest does
        failingTestEvent.test.fn()
      })
    })
  })
})
