'use strict'

describe('impacted concurrent tests', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('I am running concurrent hooks')
  })

  test.concurrent('can pass normally', () => {
    const first = 1
    const second = 2
    const result = first + second
    const label = 'sum'
    const expected = 3

    expect(`${label}:${result}`).toBe(`${label}:${expected}`)
  })

  const parameterizedTest = test.concurrent.each([
    ['parameterized row', 1, 2],
  ])
  parameterizedTest('%s can pass normally', (_label, first, second) => {
    const result = first + second
    const eachLabel = 'each-sum'
    const expected = 3

    expect(`${eachLabel}:${result}`).toBe(`${eachLabel}:${expected}`)
  })

  if (process.env.RUN_SLOW_CONCURRENT_IMPACTED_TEST) {
    // Runs past the 5s bucket, so the timeout has to exceed Jest's 5s default.
    test.concurrent('uses its duration retry budget', () => {
      const slowLabel = 'slow'
      return new Promise(resolve => {
        setTimeout(() => {
          expect(slowLabel).toBe('slow')
          resolve()
        }, 5100)
      })
    }, 20_000)
  }
})
