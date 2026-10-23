'use strict'

const assert = require('node:assert/strict')

const { getUnusedPackageName } = require('./get-unused-package-name')

describe('getUnusedPackageName', () => {
  it('returns a package name absent from the input', () => {
    assert.equal(getUnusedPackageName([]), 'unused-package')
    assert.equal(
      getUnusedPackageName(['unused-package', 'unused-unused-package']),
      'unused-unused-unused-package'
    )
  })
})
