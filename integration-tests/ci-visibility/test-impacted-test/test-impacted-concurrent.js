'use strict'

describe('impacted concurrent tests', () => {
  test.concurrent('can pass normally', () => {
    const first = 1
    const second = 2
    const result = first + second
    const label = 'sum'
    const expected = 3

    expect(`${label}:${result}`).toBe(`${label}:${expected}`)
  })
})
