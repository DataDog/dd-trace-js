'use strict'

const { test, fc } = require('@fast-check/jest')

describe('fast check', () => {
  test.prop([fc.string(), fc.string(), fc.string()])('will not include seed', (a, b, c) => {
    return (a + b + c).includes(b)
  })
})
