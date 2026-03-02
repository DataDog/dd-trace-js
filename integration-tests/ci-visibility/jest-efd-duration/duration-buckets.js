'use strict'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('efd duration buckets', () => {
  it('fast test', async () => {
    await sleep(0)
  })

  it('medium test ~6s', async () => {
    await sleep(6000)
  })

  it('slow test ~15s', async () => {
    await sleep(15000)
  })
})
