'use strict'

test('first test', () => {
  expect(true).toBe(process.env.JEST_SETUP_ERROR_MODE !== 'body')
})
