'use strict'

const assert = require('assert')

const { exec } = require('child_process')
const { once } = require('events')
const { sandboxCwd, useSandbox } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')

const packageManagers = new Map([
  ['yarn', './node_modules/.bin/yarn'],
  ['npm', './node_modules/.bin/npm'],
  ['pnpm', 'node ./node_modules/pnpm/bin/pnpm.mjs'],
])

describe('test optimization startup', () => {
  let cwd, receiver, childProcess, processOutput

  useSandbox([...packageManagers.keys()], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    processOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  /**
   * @param {string} command
   * @param {Record<string, string>} env
   */
  async function runCommand (command, env) {
    childProcess = exec(command,
      {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: '-r dd-trace/ci/init',
          ...env,
        },
      }
    )

    childProcess.stdout?.on('data', (chunk) => {
      processOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      processOutput += chunk.toString()
    })

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      once(childProcess.stdout, 'end'),
      once(childProcess.stderr, 'end'),
    ])

    return exitCode
  }

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  for (const [packageManager, command] of packageManagers) {
    it(`skips initialization for ${packageManager}`, async () => {
      const exitCode = await runCommand(`${command} -v`, { DD_TRACE_DEBUG: '1' })

      assert.strictEqual(exitCode, 0, processOutput)
      assert.match(processOutput, /dd-trace is not initialized in a package manager/)
    })
  }

  it('does not interfere with native pnpm', async () => {
    const exitCode = await runCommand('./node_modules/.bin/pnpm -v', { DD_TRACE_DEBUG: '1' })

    assert.strictEqual(exitCode, 0, processOutput)
  })

  it('does not skip initialization for non package managers', async () => {
    await runCommand('node -e "console.log(\'hello!\')"', { DD_TRACE_DEBUG: '1' })

    assert.match(processOutput, /hello!/)
    assert.doesNotMatch(processOutput, /dd-trace is not initialized in a package manager/)
  })

  it('fails if DD_API_KEY is not set when in a non test worker', async () => {
    await runCommand('node -e "console.log(\'hello!\')"', {
      DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
      DD_API_KEY: '',
    })

    assert.match(processOutput, /hello!/)
    assert.match(processOutput, /dd-trace will not be initialized/)
  })

  it('does not fail if DD_API_KEY is not set when in a test worker', async () => {
    await runCommand('node -e "console.log(\'hello!\')"', {
      DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
      DD_API_KEY: '',
      JEST_WORKER_ID: '1', // worker id is set in jest workers
    })

    assert.match(processOutput, /hello!/)
    assert.doesNotMatch(processOutput, /dd-trace will not be initialized/)
  })

  it('does not log an unknown telemetry option in a Vitest worker', async () => {
    await runCommand('node -e "console.log(\'hello!\')"', {
      DD_TRACE_DEBUG: '1',
      TINYPOOL_WORKER_ID: '1',
    })

    assert.match(processOutput, /hello!/)
    assert.doesNotMatch(processOutput, /Unknown option telemetry/)
  })
})
