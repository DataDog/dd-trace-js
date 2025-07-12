'use strict'

const { exec } = require('child_process')

const { assert } = require('chai')

const { createSandbox } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')

const packageManagers = ['yarn', 'npm', 'pnpm']

describe('test optimization startup', () => {
  let sandbox, cwd, receiver, childProcess, processOutput

  before(async () => {
    sandbox = await createSandbox(packageManagers, true)
    cwd = sandbox.folder
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async function () {
    processOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  packageManagers.forEach(packageManager => {
    it(`skips initialization for ${packageManager}`, (done) => {
      childProcess = exec(`node ./node_modules/.bin/${packageManager} -v`,
        {
          cwd,
          env: {
            ...process.env,
            NODE_OPTIONS: '-r dd-trace/ci/init',
            DD_TRACE_DEBUG: '1'
          },
          stdio: 'pipe'
        }
      )

      childProcess.stdout.on('data', (chunk) => {
        processOutput += chunk.toString()
      })

      childProcess.on('exit', () => {
        assert.include(processOutput, 'dd-trace is not initialized in a package manager')
        done()
      })
    })
  })

  it('does not skip initialization for non package managers', (done) => {
    childProcess = exec('node -e "console.log(\'hello!\')"',
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_TRACE_DEBUG: '1'
        },
        stdio: 'pipe'
      }
    )

    childProcess.stdout.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      assert.include(processOutput, 'hello!')
      assert.notInclude(processOutput, 'dd-trace is not initialized in a package manager')
      done()
    })
  })
})
