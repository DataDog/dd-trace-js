'use strict'

const crypto = require('crypto')
const { test, expect } = require('@playwright/test')

const uuid = crypto.randomBytes(16).toString('hex')
  .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')

test.describe('dynamic name suite', () => {
  test(`can do stuff at ${Date.now()}`, () => {
    expect(1 + 2).toBe(3)
  })

  test(`connects to localhost:${3000 + Math.floor(Math.random() * 60000)}`, () => {
    expect(2 + 3).toBe(5)
  })

  test(`user session ${uuid}`, () => {
    expect(3 + 4).toBe(7)
  })

  test(`created at ${new Date().toISOString()}`, () => {
    expect(4 + 5).toBe(9)
  })

  test(`event on ${new Date().toISOString().split('T')[0]}`, () => {
    expect(5 + 6).toBe(11)
  })

  test(`probability ${Math.random()}`, () => {
    expect(6 + 7).toBe(13)
  })

  test(`server at 127.0.0.1:${3000 + Math.floor(Math.random() * 60000)}`, () => {
    expect(7 + 8).toBe(15)
  })

  test(`bound to 0.0.0.0:${3000 + Math.floor(Math.random() * 60000)}`, () => {
    expect(8 + 9).toBe(17)
  })
})
