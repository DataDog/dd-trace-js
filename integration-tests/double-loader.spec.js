'use strict'

const { execSync } = require('child_process')
const path = require('path')
const assert = require('assert')
const { describe, it } = require('mocha')

describe('double-loader scenario', () => {
  it('does not fail', () => {
    const l1 = path.join(__dirname, 'double-loader', 'loader1.mjs')
    const l2 = path.join(__dirname, '..', 'loader-hook.mjs')
    assert.doesNotThrow(() => {
      execSync(`node --no-warnings --loader=${l1} --loader=${l2} -p 0`)
    })
  })
})
