'use strict'

const { fork, exec } = require('child_process')
const path = require('path')

const {
  FakeAgent,
  createSandbox
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const { assert } = require('chai')
const semver = require('semver')
const getPort = require('get-port')

// TODO: remove when 2.x support is removed.
// This is done because newest versions of mocha and jest do not support node@12
const isOldNode = semver.satisfies(process.version, '<=12')

const tests = [
  {
    name: 'mocha',
    dependencies: [isOldNode ? 'mocha@9' : 'mocha', 'chai', 'nyc'],
    testFile: 'ci-visibility/run-mocha.js',
    expectedStdout: '2 passing',
    expectedCoverageFiles: [
      'ci-visibility/run-mocha.js',
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: './node_modules/nyc/bin/nyc.js node ./ci-visibility/run-mocha.js'
  },
  {
    name: 'jest',
    dependencies: [isOldNode ? 'jest@28' : 'jest', 'chai'],
    testFile: 'ci-visibility/run-jest.js',
    expectedStdout: 'Test Suites: 2 passed',
    expectedCoverageFiles: [
      'ci-visibility/test/sum.js',
      'ci-visibility/test/ci-visibility-test.js',
      'ci-visibility/test/ci-visibility-test-2.js'
    ],
    runTestsWithCoverageCommand: 'node ./ci-visibility/run-jest.js'
  }
]

tests.forEach(({
  name,
  dependencies,
  testFile,
  expectedStdout,
  expectedCoverageFiles,
  runTestsWithCoverageCommand
}) => {
  describe(name, () => {
    let receiver
    let childProcess
    let sandbox
    let cwd
    let startupTestFile
    let testOutput = ''

    before(async () => {
      sandbox = await createSandbox(dependencies, true)
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, testFile)
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      const port = await getPort()
      const isAgentlessTest = this.currentTest.parent.title === 'agentless'
      const Receiver = isAgentlessTest ? FakeCiVisIntake : FakeAgent
      receiver = await new Receiver(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      testOutput = ''
      await receiver.stop()
    })

    it('can run tests and report spans', (done) => {
      receiver.assertMessageReceived(({ payload }) => {
        const testSpans = payload.flatMap(trace => trace)
        const resourceNames = testSpans.map(span => span.resource)

        assert.includeMembers(resourceNames,
          [
            'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
            'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2'
          ]
        )
        const areAllTestSpans = testSpans.every(span => span.name === `${name}.test`)
        assert.isTrue(areAllTestSpans)
        assert.include(testOutput, expectedStdout)
        done()
      }, 15000).catch(([e]) => done(e))

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/ci/init'
        },
        stdio: 'pipe'
      })
      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
    const inputs = ['DD_TRACING_ENABLED', 'DD_TRACE_ENABLED']

    inputs.forEach(input => {
      context(`when ${input}=false`, () => {
        it('does not report spans but still runs tests', (done) => {
          receiver.assertMessageReceived(() => {
            done(new Error('Should not create spans'))
          })

          childProcess = fork(startupTestFile, {
            cwd,
            env: {
              DD_TRACE_AGENT_PORT: receiver.port,
              NODE_OPTIONS: '-r dd-trace/ci/init',
              [input]: 'false'
            },
            stdio: 'pipe'
          })
          childProcess.stdout.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.on('message', () => {
            assert.include(testOutput, expectedStdout)
            done()
          })
        })
      })
    })

    describe('agentless', () => {
      it('does not init if DD_API_KEY is not set', (done) => {
        receiver.assertMessageReceived(() => {
          done(new Error('Should not create spans'))
        })
        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
            NODE_OPTIONS: '-r dd-trace/ci/init'
          },
          stdio: 'pipe'
        })
        childProcess.stdout.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.include(testOutput, expectedStdout)
          assert.include(testOutput, 'DD_CIVISIBILITY_AGENTLESS_ENABLED is set, ' +
            'but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, ' +
            'so dd-trace will not be initialized.'
          )
          done()
        })
      })
      it('can report git metadata', (done) => {
        const searchCommitsRequest = receiver.assertPayloadReceived(({ headers }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
        }, ({ url }) => url === '/api/v2/git/repository/search_commits')

        const packfileRequest = receiver.assertPayloadReceived(({ headers }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
        }, ({ url }) => url === '/api/v2/git/repository/packfile')

        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_API_KEY: '1',
            DD_APP_KEY: '1',
            DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
            DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
            DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
            NODE_OPTIONS: '-r dd-trace/ci/init'
          },
          stdio: 'pipe'
        })
        Promise.all([searchCommitsRequest, packfileRequest]).then(() => done()).catch(done)
      })
      it('can report code coverage', (done) => {
        const itrConfigRequest = receiver.assertPayloadReceived(({ headers }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          assert.propertyVal(headers, 'dd-application-key', '1')
        }, ({ url }) => url === '/api/v2/libraries/tests/services/setting')

        const codeCovRequest = receiver.assertPayloadReceived(({ headers, payload }) => {
          const [coveragePayload] = payload
          assert.propertyVal(headers, 'dd-api-key', '1')

          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
          assert.include(coveragePayload.content, {
            version: 1
          })
          const allCoverageFiles = payload.flatMap(coverage => coverage.content.files).map(file => file.filename)
          assert.includeMembers(allCoverageFiles, expectedCoverageFiles)
          assert.exists(coveragePayload.content.span_id)
          assert.exists(coveragePayload.content.trace_id)
        }, ({ url }) => url === '/api/v2/citestcov')

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...process.env,
              DD_API_KEY: '1',
              DD_APP_KEY: '1',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
              DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
              DD_CIVISIBILITY_ITR_ENABLED: 1,
              NODE_OPTIONS: '-r dd-trace/ci/init'
            },
            stdio: 'inherit'
          }
        )
        Promise.all([itrConfigRequest, codeCovRequest]).then(() => done()).catch(done)
      })
      it('does not report code coverage if disabled by the API', (done) => {
        receiver.setSettings({
          code_coverage: false,
          tests_skipping: false
        })

        receiver.assertPayloadReceived(() => {
          const error = new Error('it should not report code coverage')
          done(error)
        }, ({ url }) => url === '/api/v2/citestcov')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          assert.includeMembers(eventTypes, ['test', 'test_session_end', 'test_suite_end'])
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...process.env,
              DD_API_KEY: '1',
              DD_APP_KEY: '1',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
              DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
              DD_CIVISIBILITY_ITR_ENABLED: 1,
              NODE_OPTIONS: '-r dd-trace/ci/init'
            },
            stdio: 'inherit'
          }
        )
      })
      it('can skip suites received by the intelligent test runner API and still reports code coverage', (done) => {
        const skippableRequest = receiver.assertPayloadReceived(({ headers }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          assert.propertyVal(headers, 'dd-application-key', '1')
        }, ({ url }) => url === '/api/v2/ci/tests/skippable')

        const coverageRequest = receiver.assertPayloadReceived(({ payload, headers }) => {
          const [coveragePayload] = payload
          assert.propertyVal(headers, 'dd-api-key', '1')
          assert.propertyVal(coveragePayload, 'name', 'coverage1')
          assert.propertyVal(coveragePayload, 'filename', 'coverage1.msgpack')
          assert.propertyVal(coveragePayload, 'type', 'application/msgpack')
        }, ({ url }) => url === '/api/v2/citestcov')

        const eventsRequest = receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          const skippedTest = payload.events.find(event =>
            event.content.resource === 'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests'
          )
          assert.notExists(skippedTest)
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 1)
        }, ({ url }) => url === '/api/v2/citestcycle')

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])
        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...process.env,
              DD_API_KEY: '1',
              DD_APP_KEY: '1',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
              DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
              DD_CIVISIBILITY_ITR_ENABLED: 1,
              NODE_OPTIONS: '-r dd-trace/ci/init'
            },
            stdio: 'inherit'
          }
        )
        Promise.all([skippableRequest, eventsRequest, coverageRequest]).then(() => done()).catch(done)
      })
      it('does not skip tests if git metadata upload fails', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        receiver.setGitUploadStatus(404)

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...process.env,
              DD_API_KEY: '1',
              DD_APP_KEY: '1',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
              DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
              DD_CIVISIBILITY_ITR_ENABLED: 1,
              NODE_OPTIONS: '-r dd-trace/ci/init'
            },
            stdio: 'inherit'
          }
        )
      })
      it('does not skip tests if test skipping is disabled by the API', (done) => {
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request skippable')
          done(error)
        }, ({ url }) => url === '/api/v2/ci/tests/skippable')

        receiver.assertPayloadReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'dd-api-key', '1')
          const eventTypes = payload.events.map(event => event.type)
          // because they are not skipped
          assert.includeMembers(eventTypes, ['test', 'test_suite_end', 'test_session_end'])
          const numSuites = eventTypes.reduce(
            (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
          )
          assert.equal(numSuites, 2)
        }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

        receiver.setSettings({
          code_coverage: true,
          tests_skipping: false
        })

        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/test/ci-visibility-test.js'
          }
        }])

        childProcess = exec(
          runTestsWithCoverageCommand,
          {
            cwd,
            env: {
              ...process.env,
              DD_API_KEY: '1',
              DD_APP_KEY: '1',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 1,
              DD_CIVISIBILITY_AGENTLESS_URL: `http://127.0.0.1:${receiver.port}`,
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 1,
              DD_CIVISIBILITY_ITR_ENABLED: 1,
              NODE_OPTIONS: '-r dd-trace/ci/init'
            },
            stdio: 'inherit'
          }
        )
      })
    })
  })
})
