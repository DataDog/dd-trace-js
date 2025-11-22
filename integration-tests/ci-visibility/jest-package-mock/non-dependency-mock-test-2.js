'use strict'

const assert = require('node:assert/strict')





const hello = jest.requireActual('some-package')

test('hello function returns correct greeting', () => {
  assert.strictEqual(hello(), 'Hello, world!')
})
