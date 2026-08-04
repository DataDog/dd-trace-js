'use strict'

const { setTimeout: sleep } = require('node:timers/promises')

describe('long-running fixture', () => {
  it('runs long enough to be interrupted', async function () {
    this.timeout(10_000)
    await sleep(3_000)
  })
})
