'use strict'

test('second test', () => {
  expect(true).toBe(process.env.JEST_SETUP_ERROR_MODE !== 'body')
})
