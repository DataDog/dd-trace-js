'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { channel, tracingChannel } = require('../../src/helpers/instrument')
const instrumentations = require('../../src/helpers/instrumentations')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  WORKER_READY,
  WORKER_READY_RESPONSE,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../src/mocha/webdriverio-protocol')

process.env[WEBDRIVERIO_WORKER_ENV] = 'true'
process.env.DD_TEST_FAILURE_VIDEOS_ENABLED = 'true'
require('../../src/webdriverio')
const existingMochaHookCount = instrumentations.mocha?.length || 0
require('../../src/mocha/worker')

const webdriverioMochaHooks = instrumentations.mocha.slice(existingMochaHookCount)
const mochaHook = webdriverioMochaHooks.find(
  ({ filePattern }) => filePattern === String.raw`lib/mocha\.(?:c?js)$`
)
const runnerHook = webdriverioMochaHooks.find(
  ({ filePattern }) => filePattern === String.raw`lib/runner\.(?:c?js)$`
)

assert.ok(mochaHook)
assert.ok(runnerHook)

const workerFinishCh = channel('ci:mocha:worker:finish')
const workerConfigurationCh = channel('ci:mocha:worker:configuration')
let workerTestFramework
let workerTestFrameworkAdapter

function onWorkerFinish () {}
function onWorkerConfiguration ({ testFramework, testFrameworkAdapter }) {
  workerTestFramework = testFramework
  workerTestFrameworkAdapter = testFrameworkAdapter
}

workerFinishCh.subscribe(onWorkerFinish)
workerConfigurationCh.subscribe(onWorkerConfiguration)

/**
 * Exercises worker-ready and suite-finish messages.
 *
 */
function exerciseWorkerMessages () {
  class FakeMocha {
    constructor () {
      this.files = []
      this.options = {}
      this.suite = {
        run () {},
      }
    }

    /**
     * @returns {object}
     */
    run () {
      return {}
    }
  }

  class FakeRunner extends EventEmitter {
    constructor () {
      super()
      this.failures = 0
      this.suite = {
        eachTest () {},
      }
    }

    runTests () {}

    run () {
      this.emit('fail', { file: 'hook-fail.e2e.js', type: 'hook' })
      this.emit('end')
    }
  }

  mochaHook.hook(FakeMocha, '10.8.2')
  runnerHook.hook(FakeRunner)
  new FakeMocha().run()
  new FakeRunner().run()

  for (const [framework, adapter] of [['mocha', 'MochaAdapter'], ['jasmine', 'JasmineAdapter']]) {
    const context = { self: { _specs: [] } }
    tracingChannel(`orchestrion:@wdio/${framework}-framework:${adapter}_init`).asyncEnd.publish(context)
    let configured = false
    context.resolveCallback(() => { configured = true })
    assert.strictEqual(configured, true)
    assert.strictEqual(workerTestFrameworkAdapter, framework)
  }

  process.env.DD_TEST_FAILURE_VIDEOS_ENABLED = 'false'
  const disabled = { self: { _specs: [] } }
  tracingChannel('orchestrion:@wdio/mocha-framework:MochaAdapter_init').asyncEnd.publish(disabled)
  assert.strictEqual(disabled.resolveCallback, undefined)
  process.env.DD_TEST_FAILURE_VIDEOS_ENABLED = 'true'
}

let sendCalls = 0
process.connected = false
process.send = () => {
  sendCalls++
  throw new Error('send called after disconnect')
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 0)

process.connected = true
process.send = (message, onDone) => {
  sendCalls++
  assert.strictEqual(message.origin, WEBDRIVERIO_WORKER_ORIGIN)
  assert.strictEqual(message.name, WEBDRIVERIO_WORKER_EVENT)
  assert.ok(message.args)
  assert.strictEqual(typeof onDone, 'function')
  onDone(new Error('IPC channel closed during send'))
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 5)

process.send = (message, onDone) => {
  sendCalls++
  assert.strictEqual(message.origin, WEBDRIVERIO_WORKER_ORIGIN)
  assert.strictEqual(message.name, WEBDRIVERIO_WORKER_EVENT)
  assert.ok(message.args)
  assert.strictEqual(typeof onDone, 'function')
  onDone()
  if (message.args.name === CONFIGURATION_REQUEST) {
    process.emit('message', {
      name: CONFIGURATION_RESPONSE,
      content: {
        configuration: {
          testFramework: 'webdriverio',
        },
        requestId: message.args.content.requestId,
      },
    })
  } else if (message.args.name === WORKER_READY && message.args.content.requestId) {
    process.emit('message', {
      name: WORKER_READY_RESPONSE,
      content: {
        configuration: { testFramework: 'webdriverio' },
        requestId: message.args.content.requestId,
      },
    })
  }
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 10)
assert.strictEqual(workerTestFramework, 'webdriverio')

workerFinishCh.unsubscribe(onWorkerFinish)
workerConfigurationCh.unsubscribe(onWorkerConfiguration)
