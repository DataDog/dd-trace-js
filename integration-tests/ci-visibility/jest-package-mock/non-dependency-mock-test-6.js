'use strict'

const assert = require('node:assert/strict')

const hello = require('some-package')

test('hello function returns correct greeting', () => {
  assert.strictEqual(hello(), 'Hello, mocked world!')
})
