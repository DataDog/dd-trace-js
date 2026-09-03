'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  it('should not hinder the program from exiting', async function () {
    const [response, [code]] = await Promise.all([
      t.request(t.breakpoint.url),
      once(t.proc, 'exit'),
    ])

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body, 'hello world')
    assert.strictEqual(code, 0)
  })
})
