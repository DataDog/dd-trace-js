'use strict'

test('passing test', () => {
  expect(true).toBe(true)
})

test('failing assertion', () => {
  expect('actual value').toBe('expected value')
})

describe('failing hook', () => {
  beforeAll(() => {
    throw new Error('Test hook failed')
  })

  test('blocked by hook', () => {
    expect(true).toBe(true)
  })
})

afterAll(() => {
  throw new Error('Test teardown failed')
})
