'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')

const Mocha = require('mocha')
const { afterEach, describe, it } = Mocha
const sinon = require('sinon')

const {
  createParallelIt,
  spawnPluginIntegrationTestProcAndExpectExit,
  spawnProcAndExpectExit,
  stopProc,
  withReceiver,
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
    const completed = spawnPluginIntegrationTestProcAndExpectExit(
      process.cwd(),
      'unused',
      0,
      { NODE_OPTIONS: `--loader=${noopLoader}` },
      ['-e', 'process.exit(0)'],
      undefined,
      100
    )
    proc = completed.proc

    assert.notStrictEqual(proc.pid, undefined)
    await completed
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('stops a process that does not exit before its deadline', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeoutMs = 100
    const completed = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'setInterval(() => {}, 1_000)'],
      silent: true,
    }, undefined, undefined, timeoutMs)
    proc = completed.proc

    await once(proc, 'spawn')

    const rejected = assert.rejects(completed, {
      code: 'ERR_PROCESS_TIMEOUT',
      message: `Process did not exit within ${timeoutMs} ms.`,
    })
    clock.tick(timeoutMs)

    await rejected
    assert.notStrictEqual(proc.signalCode, null)
  })

  it('rejects when the process cannot start', async () => {
    const completed = spawnProcAndExpectExit('unused', {
      cwd: path.join(__dirname, 'does-not-exist'),
      silent: true,
    })
    proc = completed.proc

    await assert.rejects(completed, { code: 'ENOENT' })
    proc = undefined
  })

  it('rejects when the process exits with a nonzero status', async () => {
    const completed = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'process.exit(1)'],
      silent: true,
    })
    proc = completed.proc

    await assert.rejects(completed, {
      message: 'Process exited with status code 1.',
    })
  })

  it('rejects when a timed out process cannot be stopped', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const completed = spawnProcAndExpectExit('unused', {
      execArgv: ['-e', 'setInterval(() => {}, 1_000)'],
      silent: true,
    }, undefined, undefined, 100)
    proc = completed.proc

    await once(proc, 'spawn')
    const kill = sinon.stub(proc, 'kill')
    kill.onFirstCall().callsFake(() => {
      proc.emit('error', new Error('late process error'))
      return true
    })
    kill.onSecondCall().returns(true)
    const rejected = assert.rejects(completed, {
      message: `Process ${proc.pid} did not exit after SIGKILL`,
    })
    await clock.tickAsync(4_100)

    await rejected
    assert.strictEqual(kill.callCount, 2)
  })
})

describe('withReceiver', () => {
  // These cases verify POSIX exec shell replacement; Windows uses cmd.exe.
  const posixIt = process.platform === 'win32' ? it.skip : it
  for (const fails of [false, true]) {
    posixIt(`waits for its child to stop when the body ${fails ? 'fails' : 'passes'}`, async () => {
      let proc
      const error = new Error('test body failed')
      const runTest = withReceiver(async (receiver, run) => {
        proc = run('node -e "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"')
        const [pid] = await once(proc.stdout, 'data')
        assert.strictEqual(Number(pid), proc.pid)
        if (fails) throw error
      })

      try {
        if (fails) await assert.rejects(runTest(), error)
        else await runTest()
        assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'child must exit before cleanup resolves')
      } finally {
        await stopProc(proc)
      }
    })
  }

  it('preserves a failure and starts a fresh retry after closing a pending request', async () => {
    const mocha = new Mocha({ reporter: class {} })
    const parallelIt = createParallelIt((name, fn) => mocha.suite.addTest(new Mocha.Test(name, fn)), {
      withReceiver: true,
    })
    const error = new Error('original assertion')
    const requests = []
    const retryErrors = []
    let attempts = 0

    parallelIt('pending request', async (receiver) => {
      attempts++
      if (attempts === 2) return
      receiver.setMediaResponsesPending()
      const received = once(receiver.server, 'request')
      const request = http.request({
        port: receiver.port,
        method: 'POST',
        path: '/api/v2/ci/test-runs/123/media',
        headers: { 'content-length': 0 },
      })
      requests.push(request)
      request.on('error', () => {})
      request.end()
      await received
      throw error
    }, { retries: 1 })

    try {
      const failures = await new Promise(resolve => {
        mocha.run(resolve).on('retry', (test, error) => retryErrors.push(error))
      })
      assert.strictEqual(failures, 0)
      assert.strictEqual(attempts, 2)
      assert.deepStrictEqual(retryErrors, [error])
    } finally {
      for (const request of requests) request.destroy()
    }
  })
})
