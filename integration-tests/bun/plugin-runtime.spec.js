'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { join } = require('node:path')

const { devDependencies } = require('../../package.json')
const { BUN } = require('../helpers/bun')
const { pluginRuntimeOptions } = require('./plugin-runtime')

describe('Bun plugin application runtime', () => {
  it('leaves Node options unchanged when unset', () => {
    const options = { env: { NODE_OPTIONS: '--loader=dd-trace/loader-hook.mjs' }, execArgv: ['--expose-gc'] }
    assert.strictEqual(pluginRuntimeOptions(options), options)
  })

  it('translates loader and import flags and clears NODE_OPTIONS only for Bun', () => {
    const options = {
      env: { DD_TEST_RUNTIME: 'bun', NODE_OPTIONS: '--loader=dd-trace/loader-hook.mjs --require "./with space.cjs"' },
      execArgv: ['--import', 'dd-trace/initialize.mjs'],
    }
    const result = pluginRuntimeOptions(options)
    assert.strictEqual(result.execPath, BUN)
    assert.deepStrictEqual(result.execArgv, [
      '--preload', 'dd-trace/initialize.mjs', '--preload', './with space.cjs',
      '--preload', 'dd-trace/initialize.mjs',
    ])
    assert.strictEqual(result.env.NODE_OPTIONS, '')
    assert.notStrictEqual(result.env, options.env)
    assert.match(options.env.NODE_OPTIONS, /--loader/)
  })

  it('supports import, require and register preload variants', () => {
    for (const flag of ['--import', '--require', '-r']) {
      const result = pluginRuntimeOptions({
        env: { DD_TEST_RUNTIME: 'bun', NODE_OPTIONS: `${flag}=dd-trace/init.js` },
      })
      assert.deepStrictEqual(result.execArgv, ['--preload', 'dd-trace/init.js'])
    }
    const result = pluginRuntimeOptions({
      env: { DD_TEST_RUNTIME: 'bun', NODE_OPTIONS: '--import dd-trace/register.js' },
    })
    assert.deepStrictEqual(result.execArgv, ['--preload', 'dd-trace/initialize.mjs'])
  })

  it('preserves non-loader arguments and handles empty options', () => {
    const result = pluginRuntimeOptions({ env: { DD_TEST_RUNTIME: 'bun' }, execArgv: ['--expose-gc'] })
    assert.deepStrictEqual(result.execArgv, ['--expose-gc'])
    assert.deepStrictEqual(pluginRuntimeOptions({ env: { DD_TEST_RUNTIME: 'bun' } }).execArgv, [])
  })

  it('rejects unsupported loaders, malformed quotes and missing paths', () => {
    for (const NODE_OPTIONS of ['--loader=other-loader.mjs', '--require "unterminated', '--import']) {
      assert.throws(() => pluginRuntimeOptions({ env: { DD_TEST_RUNTIME: 'bun', NODE_OPTIONS } }), Error)
    }
  })

  it('forks the pinned Bun with working IPC, stdout and stderr', async () => {
    const proc = fork(join(__dirname, 'plugin-runtime-fixture.cjs'), {
      ...pluginRuntimeOptions({ env: { ...process.env, DD_TEST_RUNTIME: 'bun', NODE_OPTIONS: '' } }),
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    const closed = once(proc, 'close')
    try {
      const [message] = await once(proc, 'message')
      assert.strictEqual(message.bun, devDependencies.bun)
      const reply = once(proc, 'message')
      proc.send({ ipc: 'works' })
      assert.deepStrictEqual((await reply)[0], { ipc: 'works' })
      assert.strictEqual((await closed)[0], 0)
      assert.match(stdout, /stdout works/)
      assert.match(stderr, /stderr works/)
    } finally {
      proc.kill()
    }
  })
})
