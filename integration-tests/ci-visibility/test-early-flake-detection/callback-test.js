'use strict'

describe('early flake detection callback', () => {
  // Retries are re-registered through a wrapper, so they only keep waiting for `done`
  // as long as that wrapper reports the same arity as the original.
  test('new test using a done callback', (done) => {
    setTimeout(() => {
      expect(1 + 2).toBe(3)
      done()
    }, 10)
  })
})
