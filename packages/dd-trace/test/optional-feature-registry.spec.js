'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')

const { optionalFeatures, registerOptionalFeature } = require('../src/optional-feature-registry')

describe('optional-feature-registry', () => {
  let originalKeys

  beforeEach(() => {
    originalKeys = Object.keys(optionalFeatures)
  })

  afterEach(() => {
    for (const key of Object.keys(optionalFeatures)) {
      if (!originalKeys.includes(key)) {
        delete optionalFeatures[key]
      }
    }
  })

  it('registers a feature by name', () => {
    const factory = () => ({ enable () {}, disable () {} })

    registerOptionalFeature({ name: 'example', factory })

    assert.strictEqual(optionalFeatures.example.name, 'example')
    assert.strictEqual(optionalFeatures.example.factory, factory)
  })
})
