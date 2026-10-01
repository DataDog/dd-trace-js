'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { exec } = require('./run-util')

describe('Sirun process runner', () => {
  it('resolves when the process finishes within the limit', async () => {
    await exec(process.execPath, ['-e', ''], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 1000,
    })
  })

  it('rejects and terminates a process that exceeds the limit', async () => {
    const start = Date.now()

    await assert.rejects(
      exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: 50,
      }),
      error => error.code === 'ETIMEDOUT' && /0\.05-second variant limit/.test(error.message)
    )

    assert.ok(Date.now() - start < 2000)
  })
})
