'use strict'

afterAll(() => {
  process.nextTick(() => {
    require('./off-timing-import.js')
  })
})
it('will fail', () => {
  expect(true).toBe(true)
})
