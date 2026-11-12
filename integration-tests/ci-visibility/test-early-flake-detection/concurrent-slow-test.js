'use strict'

describe('efd concurrent slow retries', () => {
  // The slower sibling runs first, so Jest awaits the test below long after it finished.
  test.concurrent('slower concurrent sibling', async () => {
    await new Promise(resolve => setTimeout(resolve, 6200))
  }, 20_000)

  test.concurrent('slow concurrent test', async () => {
    await new Promise(resolve => setTimeout(resolve, 5200))
  }, 20_000)
})
