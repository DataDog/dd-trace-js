'use strict'

describe('concurrent disabled tests', () => {
  test.concurrent('can disable concurrent test before body runs', async () => {
    // eslint-disable-next-line no-console
    console.log('I am running concurrent disabled')
    throw new Error('This test should have been disabled before the body ran.')
  })

  test.concurrent('can disable done concurrent test before body runs', (done) => {
    // eslint-disable-next-line no-console
    console.log('I am running concurrent disabled done')
    done(new Error('This test should have been disabled before the body ran.'))
  })

  test.concurrent('can run another concurrent test', async () => {
    expect(1 + 2).toBe(3)
  })
})
