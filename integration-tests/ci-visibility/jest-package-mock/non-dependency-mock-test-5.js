'use strict'

const hello = require('some-package')

test('hello function returns correct greeting', () => {
  expect(hello()).toBe('Hello, mocked world!')
})
