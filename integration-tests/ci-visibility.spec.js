'use strict'

const { fork } = require('child_process')
const path = require('path')

const {
  FakeAgent,
  createSandbox
} = require('./helpers')
const { assert } = require('chai')
const semver = require('semver')
const getPort = require('get-port')

// TODO: remove when 2.x support is removed.
// This is done because newest versions of mocha and jest do not support node@12
const isOldNode = semver.satisfies(process.version, '<=12')

const tests = [
  {
    name: 'mocha',
    dependencies: [isOldNode ? 'mocha@9' : 'mocha', 'chai'],
    testFile: 'ci-visibility/run-mocha.js',
    expectedStdout: '1 passing'
  },
  {
    name: 'jest',
    dependencies: [isOldNode ? 'jest@28' : 'jest', 'chai'],
    testFile: 'ci-visibility/run-jest.js',
    expectedStdout: 'Test Suites: 1 passed'
  }
]

tests.forEach(({ name, dependencies, testFile, expectedStdout }) => {
  describe(name, () => {
    let agent
    let childProcess
    let sandbox
    let cwd
    let startupTestFile
    let testOutput = ''

    before(async () => {
      sandbox = await createSandbox(dependencies)
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, testFile)
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      const port = await getPort()
      agent = await new FakeAgent(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      testOutput = ''
      await agent.stop()
    })

    it('can run tests and report spans', (done) => {
      agent.assertMessageReceived(({ payload }) => {
        const testSpan = payload[0][0]
        assert.strictEqual(testSpan.resource, 'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests')
        assert.strictEqual(testSpan.name, `${name}.test`)
        assert.include(testOutput, expectedStdout)
        done()
      }).catch(([e]) => done(e))

      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
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
          agent.assertMessageReceived(() => {
            done(new Error('Should not create spans'))
          })

          childProcess = fork(startupTestFile, {
            cwd,
            env: {
              DD_TRACE_AGENT_PORT: agent.port,
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
  })
})
