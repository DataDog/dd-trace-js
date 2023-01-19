'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

describe('playwright', () => {
  let sandbox, cwd, testCommand, receiver, childProcess
  before(async () => {
    sandbox = await createSandbox(['@playwright/test'], true)
    cwd = sandbox.folder
    // install necessary browser
    await execSync('npx playwright install', { cwd })
    testCommand = './node_modules/.bin/playwright test'
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async function () {
    const port = await getPort()
    receiver = await new FakeCiVisIntake(port).start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })
  it('can run and report tests', (done) => {
    receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle').then(eventsRequest => {
      const eventTypes = eventsRequest.payload.events.map(event => event.type)
      assert.includeMembers(eventTypes, ['span', 'test', 'test_suite_end', 'test_module_end', 'test_session_end'])
      const numSuites = eventTypes.reduce(
        (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
      )
      const numModules = eventTypes.reduce(
        (acc, type) => type === 'test_module_end' ? acc + 1 : acc, 0
      )
      assert.equal(numSuites, 1)
      assert.equal(numModules, 1)
      done()
    })
    childProcess = exec(
      testCommand,
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
        stdio: 'pipe'
      }
    )
    childProcess.stderr.pipe(process.stderr)
    childProcess.stdout.pipe(process.stdout)
  })
})
