'use strict'

const assert = require('assert')

const hello = jest.requireActual('some-package')

test('hello function returns correct greeting', () => {
  assert.strictEqual(hello(), 'Hello, world!')
})
