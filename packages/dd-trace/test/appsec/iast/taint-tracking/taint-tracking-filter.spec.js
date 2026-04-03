'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

describe('IAST TaintTrackingFilter', () => {
  let filter

  describe('isPrivateModule', () => {
    beforeEach(() => {
      filter = require('../../../../src/appsec/iast/taint-tracking/filter')
    })

    afterEach(sinon.restore)

    it('Filename outside node_modules is private', () => {
      const filename = 'test.js'
      assert.strictEqual(filter.isPrivateModule(filename), true)
    })

    it('Filename inside node_modules is not private', () => {
      const filename = 'node_modules/test-package/test.js'
      assert.strictEqual(filter.isPrivateModule(filename), false)
    })
  })
})
