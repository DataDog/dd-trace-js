'use strict'

const value = require('./helpers/mock')

let attempt = 0

it('uses the mock and native retry budget declared in a helper', () => {
  expect(value).toBe('mocked')
  expect(++attempt).toBe(3)
})
