'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { setTimeout } = require('node:timers')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { MessageChannel } = require('node:worker_threads')

const proxyquire = require('proxyquire').noCallThru()

let onIdle
const idle = new Promise(resolve => { onIdle = resolve })
const Hook = proxyquire('../../src/helpers/hook', {
  'node:timers': {
    /**
     * @param {() => void} callback
     * @param {number} delay
     */
    setTimeout (callback, delay) {
      assert.strictEqual(delay, 1000)
      return setTimeout(() => {
        callback()
        onIdle()
      }, 0)
    },
  },
})

Hook(['semver'], exports => exports)

async function main () {
  const storage = new AsyncLocalStorage()
  const { port1, port2 } = new MessageChannel()
  port1.ref()
  try {
    const store = storage.run({ request: true }, () => {
      require('semver')
      return new WeakRef(storage.getStore())
    })
    await idle
    for (let i = 0; i < 5; i++) {
      await nextTurn()
      global.gc()
    }
    assert.strictEqual(store.deref(), undefined)
    process.stdout.write('collected\n')
  } finally {
    storage.disable()
    port1.close()
    port2.close()
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
