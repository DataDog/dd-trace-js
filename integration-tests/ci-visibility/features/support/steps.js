'use strict'

const tracer = require('dd-trace')
const assert = require('node:assert/strict')
const { setTimeout: sleep } = require('node:timers/promises')
const { When, Then, Before, After } = require('@cucumber/cucumber')

const CUCUMBER_WORKER_TRACE_PAYLOAD_CODE = 70
const delayCucumberWorkerMessagesMs = Number(process.env.DD_TEST_DELAY_CUCUMBER_WORKER_MESSAGES_MS) || 0
const slowDurationDelayMs = process.env.SHOULD_ADD_SLOW_DURATION_TEST ? 5100 : 0

function isDdTraceWorkerTraceMessage (message) {
  return Array.isArray(message) && message[0] === CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
}

if (delayCucumberWorkerMessagesMs > 0 && process.env.CUCUMBER_WORKER_ID && process.send) {
  const originalProcessSend = process.send

  process.send = function (...args) {
    const [message] = args

    if (isDdTraceWorkerTraceMessage(message)) {
      return originalProcessSend.apply(process, args)
    }

    global.setTimeout(() => {
      originalProcessSend.apply(process, args)
    }, delayCucumberWorkerMessagesMs)

    return true
  }
}

if (delayCucumberWorkerMessagesMs > 0 && process.env.CUCUMBER_WORKER_ID) {
  try {
    const { isMainThread, parentPort } = require('node:worker_threads')

    if (!isMainThread && parentPort) {
      const originalPostMessage = parentPort.postMessage

      parentPort.postMessage = function (...args) {
        const [message] = args

        if (isDdTraceWorkerTraceMessage(message)) {
          return originalPostMessage.apply(parentPort, args)
        }

        global.setTimeout(() => {
          originalPostMessage.apply(parentPort, args)
        }, delayCucumberWorkerMessagesMs)
      }
    }
  } catch {
    // This fixture also runs on old Node versions where worker_threads may be unavailable.
  }
}

class Greeter {
  sayFarewell () {
    return 'farewell'
  }

  sayGreetings () {
    return 'greetings'
  }

  sayYo () {
    return 'yo'
  }

  sayYeah () {
    return 'yeah whatever'
  }
}

Before('@skip', function () {
  return 'skipped'
})

After(function () {
  tracer.scope().active().addTags({
    'custom_tag.after': 'hello after',
  })
})

Before(function () {
  tracer.scope().active().addTags({
    'custom_tag.before': 'hello before',
  })
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says farewell', function () {
  this.whatIHeard = new Greeter().sayFarewell()
})

When('the greeter says yo', function () {
  this.whatIHeard = new Greeter().sayYo()
})

When('the greeter says yeah', function () {
  this.whatIHeard = new Greeter().sayYeah()
})

When('the greeter says greetings', function () {
  tracer.scope().active().addTags({
    'custom_tag.when': 'hello when',
  })
  this.whatIHeard = new Greeter().sayGreetings()
})

When('the greeter says whatever', async function () {
  await sleep(slowDurationDelayMs)
  this.whatIHeard = 'whatever'
})
