'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const { createSandbox } = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

describe('test optimization startup', () => {
  let sandbox, cwd, receiver, childProcess

  before(async () => {
    sandbox = await createSandbox(['yarn', 'npm', 'pnpm'], true)
    cwd = sandbox.folder
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

  it('skips initialization for yarn', (done) => {
    let testOutput

    childProcess = exec('node ./node_modules/.bin/yarn -v',
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
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      assert.include(testOutput, 'dd-trace is not initialized in a package manager')
      done()
    })
  })

  it('skips initialization for npm', (done) => {
    let testOutput

    childProcess = exec('node ./node_modules/.bin/npm -v',
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
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      assert.include(testOutput, 'dd-trace is not initialized in a package manager')
      done()
    })
  })

  it('skips initialization for pnpm', (done) => {
    let testOutput

    childProcess = exec('node ./node_modules/.bin/pnpm -v',
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
      testOutput += chunk.toString()
    })

    childProcess.on('exit', () => {
      assert.include(testOutput, 'dd-trace is not initialized in a package manager')
      done()
    })
  })
})
