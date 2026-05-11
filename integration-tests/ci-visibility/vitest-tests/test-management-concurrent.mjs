import { describe, test, expect } from 'vitest'

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('concurrent test management', () => {
  test.concurrent('can attempt to fix a concurrent test', async () => {
    await wait(20)
    // eslint-disable-next-line no-console
    console.log('I am running concurrent attempt to fix')
    expect(1 + 2).to.equal(4)
  })

  test.concurrent('can disable a concurrent test', async () => {
    await wait(15)
    // eslint-disable-next-line no-console
    console.log('I am running concurrent disabled')
    expect(1 + 2).to.equal(4)
  })

  test.concurrent('can quarantine a concurrent test', async () => {
    await wait(10)
    // eslint-disable-next-line no-console
    console.log('I am running concurrent quarantined')
    expect(1 + 2).to.equal(4)
  })

  test.concurrent('can pass normally in a concurrent management suite', async () => {
    await wait(5)
    expect(1 + 2).to.equal(3)
  })

  test('can attempt to fix a non-concurrent test in a mixed management suite', async () => {
    await wait(4)
    // eslint-disable-next-line no-console
    console.log('I am running non-concurrent attempt to fix')
    expect(1 + 2).to.equal(4)
  })

  test('can disable a non-concurrent test in a mixed management suite', async () => {
    await wait(3)
    // eslint-disable-next-line no-console
    console.log('I am running non-concurrent disabled')
    expect(1 + 2).to.equal(4)
  })

  test('can pass normally beside concurrent management tests', async () => {
    await wait(2)
    expect(1 + 2).to.equal(3)
  })
})
