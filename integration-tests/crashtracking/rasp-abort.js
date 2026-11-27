'use strict'

const assert = require('node:assert/strict')

function exitOnUncaughtException () {
  process.exit(1)
}

if (process.env.TEST_RASP_CAPTURE_CALLBACK === 'true') {
  process.setUncaughtExceptionCaptureCallback(exitOnUncaughtException)
}

process.on('uncaughtExceptionMonitor', () => {
  assert.strictEqual(process.listenerCount('uncaughtException'), 0)
})

require('../../packages/dd-trace').init({
  appsec: { enabled: true },
})

const http = require('node:http')

const { DatadogRaspAbortError } = require('../../packages/dd-trace/src/appsec/rasp/utils')

const server = http.createServer((req, res) => {
  setImmediate(() => {
    const cause = new DatadogRaspAbortError(req, res)
    if (req.url === '/direct') {
      throw cause
    }
    throw new Error('integration test handled RASP abort', { cause })
  })
})

server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const pathname of ['/direct', '/wrapped']) {
    if (pathname === '/wrapped') {
      process.setUncaughtExceptionCaptureCallback(exitOnUncaughtException)
    }

    const response = await fetch(origin + pathname)
    assert.strictEqual(response.status, 403)
    await response.arrayBuffer()
  }

  setImmediate(() => {
    const error = new TypeError('integration test uncaught exception after RASP abort')
    Object.defineProperty(error, 'cause', {
      get () {
        throw new Error('integration test cause getter threw')
      },
    })
    throw error
  })
})
