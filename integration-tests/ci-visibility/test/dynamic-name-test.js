'use strict'

const assert = require('assert')
const crypto = require('crypto')

const sum = require('./sum')

const uuid = crypto.randomBytes(16).toString('hex')
  .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')

describe('dynamic name suite', () => {
  it(`can do stuff at ${Date.now()}`, () => {
    assert.strictEqual(sum(1, 2), 3)
  })

  it(`connects to localhost:${3000 + Math.floor(Math.random() * 60000)}`, () => {
    assert.strictEqual(sum(2, 3), 5)
  })

  it(`user session ${uuid}`, () => {
    assert.strictEqual(sum(3, 4), 7)
  })

  it(`created at ${new Date().toISOString()}`, () => {
    assert.strictEqual(sum(4, 5), 9)
  })
})
