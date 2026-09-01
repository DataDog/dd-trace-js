'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const {
  spawnPluginIntegrationTestProcAndExpectExit,
  spawnProcAndExpectExit,
  stopProc,
} = require('./helpers')

describe('spawnProcAndExpectExit', () => {
  let proc

  afterEach(async () => {
    sinon.restore()
    await stopProc(proc)
  })

  it('returns the process before it exits', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const noopLoader = path.join(process.cwd(), 'integration-tests/appsec/esm-app/custom-noop-hooks.mjs')
    const spawned = spawnPluginIntegrationTestProcAndExpectExit(
      process.cwd(),
      'unused',
      0,
      { NODE_OPTIONS: `--loader=${noopLoader}` },
      ['-e', 'process.exit(0)'],
      undefined,
      100
    )
    proc = spawned.proc

    assert.notStrictEqual(proc.pid, undefined)
    await spawned.completed
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('stops a process that does not exit before its deadline', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeoutMs = 100
    const spawned = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'setInterval(() => {}, 1_000)'],
      silent: true,
    }, undefined, undefined, timeoutMs)
    proc = spawned.proc

    await once(proc, 'spawn')

    const rejected = assert.rejects(spawned.completed, {
      code: 'ERR_PROCESS_TIMEOUT',
      message: `Process did not exit within ${timeoutMs} ms.`,
    })
    clock.tick(timeoutMs)

    await rejected
    assert.notStrictEqual(proc.signalCode, null)
  })

  it('rejects when the process cannot start', async () => {
    const spawned = spawnProcAndExpectExit('unused', {
      cwd: path.join(__dirname, 'does-not-exist'),
      silent: true,
    })
    proc = spawned.proc

    await assert.rejects(spawned.completed, { code: 'ENOENT' })
    proc = undefined
  })

  it('rejects when the process exits with a nonzero status', async () => {
    const spawned = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'process.exit(1)'],
      silent: true,
    })
    proc = spawned.proc

    await assert.rejects(spawned.completed, {
      message: 'Process exited with status code 1.',
    })
  })

  it('rejects when a timed out process cannot be stopped', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const spawned = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'setInterval(() => {}, 1_000)'],
      silent: true,
    }, undefined, undefined, 100)
    proc = spawned.proc

    await once(proc, 'spawn')
    const kill = sinon.stub(proc, 'kill')
    kill.onFirstCall().callsFake(() => {
      proc.emit('error', new Error('late process error'))
      return true
    })
    kill.onSecondCall().returns(true)
    const rejected = assert.rejects(spawned.completed, {
      message: `Process ${proc.pid} did not exit after SIGKILL`,
    })
    await clock.tickAsync(4_100)

    await rejected
    assert.strictEqual(kill.callCount, 2)
  })
})
