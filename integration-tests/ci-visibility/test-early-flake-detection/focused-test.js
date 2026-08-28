'use strict'

describe('early flake detection focus', () => {
  // eslint-disable-next-line mocha/no-exclusive-tests
  test.only('known focused test', () => {
    expect(1 + 2).toBe(3)
  })

  // eslint-disable-next-line mocha/no-exclusive-tests
  test.only('new focused test skipped by pattern', () => {
    expect(2 + 1).toBe(3)
  })

  // Jest skips this test because the suite has a focused one, so none of the
  // retries pre-registered for it may be reported.
  test('new test skipped by focus', () => {
    expect(2 + 2).toBe(4)
  })
})

// eslint-disable-next-line mocha/no-exclusive-tests
describe.only('early flake detection focused block', () => {
  test('known focused test selected by focused block', () => {
    expect(3 + 1).toBe(4)
  })
})

// This skipped block verifies that Early Flake Detection does not retry skipped tests.
describe.skip('early flake detection skipped block', () => {
  test('new test inside a skipped block', () => {
    expect(3 + 3).toBe(6)
  })
})
