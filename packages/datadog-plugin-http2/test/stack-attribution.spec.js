'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

/**
 * @param {string} fixtureName
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runFixture (fixtureName) {
  return new Promise((resolve) => {
    const child = fork(
      path.join(__dirname, 'stack-attribution', fixtureName),
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          DD_TRACE_AGENT_PORT: '0',
        },
      }
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

describe('http2 client instrumentation stack attribution', () => {
  it('keeps dd-trace out of crash stacks emitted after \'response\' has fired', async () => {
    const { code, stderr } = await runFixture('with-tracer.js')

    assert.notStrictEqual(code, 0, 'process should crash with no error listener')
    assert.match(stderr, /crash from data listener/)
    assert.doesNotMatch(stderr, /datadog-instrumentations\/src\/http2\/client\.js/)
  }).timeout(10_000)

  it('matches the baseline crash without the tracer', async () => {
    const { code, stderr } = await runFixture('without-tracer.js')

    assert.notStrictEqual(code, 0, 'process should crash with no error listener')
    assert.match(stderr, /crash from data listener/)
    assert.doesNotMatch(stderr, /datadog-instrumentations/)
  }).timeout(10_000)
})
