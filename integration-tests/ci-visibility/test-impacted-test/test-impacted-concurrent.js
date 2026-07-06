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
})
