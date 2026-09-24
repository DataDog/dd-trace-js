'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')

const { registerVercelTelemetryRetention } = require('../../src/serverless/vercel')

const requestContext = Symbol.for('@vercel/request-context')
const retained = []
const flushes = []

function immediate () {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * @param {Promise<void>} promise
 */
function waitUntil (promise) {
  retained.push(promise)
}

globalThis[requestContext] = {
  get: () => ({ waitUntil }),
}

const unregister = registerVercelTelemetryRetention({
  /**
   * @param {() => void} done
   */
  flushAll (done) {
    flushes.push(done)
  },
})

async function main () {
  try {
    const finishChannel = channel('apm:http:server:request:finish')
    finishChannel.publish({ req: {} })
    await immediate()
    finishChannel.publish({ req: {} })
    finishChannel.publish({ req: {} })
    await immediate()

    assert.strictEqual(retained.length, 3)
    assert.strictEqual(retained[1], retained[2])
    assert.strictEqual(flushes.length, 1)

    let activeSettled = false
    let queuedSettled = false
    async function observeActive () {
      await retained[0]
      activeSettled = true
    }
    async function observeQueued () {
      await retained[1]
      queuedSettled = true
    }
    const activeObserved = observeActive()
    const queuedObserved = observeQueued()
    flushes[0]()
    await immediate()

    assert.strictEqual(activeSettled, true)
    assert.strictEqual(queuedSettled, false)
    assert.strictEqual(flushes.length, 2)

    flushes[1]()
    await Promise.all([activeObserved, queuedObserved])
    assert.strictEqual(queuedSettled, true)

    finishChannel.publish({ req: {} })
    await immediate()
    assert.strictEqual(retained.length, 4)
    assert.notStrictEqual(retained[3], retained[2])
    assert.strictEqual(flushes.length, 3)
    flushes[2]()
    await retained[3]
  } finally {
    unregister()
  }
}

main()
