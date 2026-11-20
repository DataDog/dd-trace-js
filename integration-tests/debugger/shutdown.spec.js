'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { setup } = require('./utils')

describe('Dynamic Instrumentation shutdown', function () {
  this.timeout(30_000)

  const t = setup({
    env: { DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS: '10' },
  })

  it('delivers a buffered snapshot when SIGTERM closes the application server', async () => {
    const snapshots = []
    t.agent.on('debugger-input', ({ payload }) => {
      snapshots.push(...payload.map(({ debugger: { snapshot } }) => snapshot))
    })
    t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
    await t.triggerBreakpoint()

    const exited = once(t.proc, 'exit')
    t.proc.kill('SIGTERM')
    const [code, signal] = await exited

    assert.strictEqual(code, 0)
    assert.strictEqual(signal, null)
    assert.strictEqual(snapshots.length, 1)
    assert.ok(snapshots[0].captures)
  })
})
