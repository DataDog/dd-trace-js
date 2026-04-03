'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { fork } = require('node:child_process')

const { describe, it } = require('mocha')

function runFixture (fixtureName) {
  return new Promise((resolve) => {
    const child = fork(
      path.join(__dirname, 'epipe-crash', fixtureName),
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          DD_TRACE_AGENT_PORT: '0',
        },
      },
    )

    let stderr = ''

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('exit', (code) => {
      resolve({ code, stderr })
    })
  })
}

describe('net instrumentation stack attribution', () => {
  it('should crash with unhandled error without tracer (baseline)', async () => {
    const { code, stderr } = await runFixture('without-tracer.js')

    assert.notStrictEqual(code, 0, 'process should crash with no error listener')
    assert.ok(
      stderr.includes('ECONNRESET') || stderr.includes('EPIPE'),
      'stderr should contain the socket error code',
    )
    assert.ok(
      !stderr.includes('datadog-instrumentations/src/net.js'),
      'stack trace should not reference dd-trace without the tracer loaded',
    )
  }).timeout(10000)

  it('should crash with unhandled error with tracer and include dd-trace in stack', async () => {
    const { code, stderr } = await runFixture('with-tracer.js')

    assert.notStrictEqual(code, 0, 'process should crash with no error listener')
    assert.ok(
      stderr.includes('ECONNRESET') || stderr.includes('EPIPE'),
      'stderr should contain the socket error code',
    )
    assert.ok(
      stderr.includes('datadog-instrumentations/src/net.js'),
      'stack trace should reference dd-trace net instrumentation',
    )
  }).timeout(10000)
})
