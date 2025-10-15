'use strict'

const { exec } = require('child_process')
const { once } = require('events')

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
    it(`skips initialization for ${packageManager}`, async () => {
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
      childProcess.stderr.on('data', (chunk) => {
        processOutput += chunk.toString()
      })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end')
      ])

      assert.include(processOutput, 'dd-trace is not initialized in a package manager')
    })
  })

  it('does not skip initialization for non package managers', async () => {
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
    childProcess.stderr.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    await Promise.all([
      once(childProcess, 'exit'),
      once(childProcess.stdout, 'end'),
      once(childProcess.stderr, 'end')
    ])

    assert.include(processOutput, 'hello!')
    assert.notInclude(processOutput, 'dd-trace is not initialized in a package manager')
  })

  it('fails if DD_API_KEY is not set when in a non test worker', async () => {
    childProcess = exec('node -e "console.log(\'hello!\')"',
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
          DD_API_KEY: '',
        },
        stdio: 'pipe'
      }
    )

    childProcess.stdout.on('data', (chunk) => {
      processOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    await Promise.all([
      once(childProcess, 'exit'),
      once(childProcess.stdout, 'end'),
      once(childProcess.stderr, 'end')
    ])

    assert.include(processOutput, 'hello!')
    assert.include(processOutput, 'dd-trace will not be initialized')
  })

  it('does not fail if DD_API_KEY is not set when in a test worker', async () => {
    childProcess = exec('node -e "console.log(\'hello!\')"',
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
          DD_API_KEY: '',
          JEST_WORKER_ID: '1' // worker id is set in jest workers
        },
        stdio: 'pipe'
      }
    )

    childProcess.stdout.on('data', (chunk) => {
      processOutput += chunk.toString()
    })
    childProcess.stderr.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    await Promise.all([
      once(childProcess, 'exit'),
      once(childProcess.stdout, 'end'),
      once(childProcess.stderr, 'end')
    ])

    assert.include(processOutput, 'hello!')
    assert.notInclude(processOutput, 'dd-trace will not be initialized')
  })
})
