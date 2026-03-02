'use strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('efd fast and slow', () => {
  it('fast test', async () => {
    await sleep(0)
  })

  it('slow test ~6s', async () => {
    await sleep(6000)
  })
})
