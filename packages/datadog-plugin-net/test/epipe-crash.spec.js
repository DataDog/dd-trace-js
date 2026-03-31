'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { fork } = require('node:child_process')

const { describe, it } = require('mocha')

describe('net instrumentation socket error handling', () => {
  it('should not crash the process when a socket error occurs without an error listener', (done) => {
    // When dd-trace wraps Socket.emit in net.js, unhandled socket errors
    // (EPIPE/ECONNRESET) crash the process. The error is emitted through
    // the wrapped emit and the stack trace points to dd-trace rather than
    // Node.js internals.
    const child = fork(
      path.join(__dirname, 'epipe-crash', 'server.js'),
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          DD_TRACE_AGENT_PORT: '0',
        },
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('exit', (code) => {
      if (code !== 0) {
        // The process crashed — bug is present
        assert.fail(
          `Process crashed with exit code ${code}. ` +
          'Socket error with no error listener should not crash the process when dd-trace instruments net.\n' +
          `stderr: ${stderr}`,
        )
      }

      assert.ok(stdout.includes('OK'), 'Expected process to complete successfully')
      done()
    })
  }).timeout(10000)
})
