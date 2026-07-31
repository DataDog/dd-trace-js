'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('mocha')

describe('optional-feature-registry', () => {
  let optionalFeatures
  let registerOptionalFeature

  beforeEach(() => {
    delete require.cache[require.resolve('../src/optional-feature-registry')]
    ;({ optionalFeatures, registerOptionalFeature } = require('../src/optional-feature-registry'))
  })

  it('starts empty', () => {
    assert.deepStrictEqual(optionalFeatures, {})
  })

  it('registers a feature by name', () => {
    const factory = () => ({ enable () {}, disable () {} })

    registerOptionalFeature({ name: 'example', factory })

    assert.strictEqual(optionalFeatures.example.name, 'example')
    assert.strictEqual(optionalFeatures.example.factory, factory)
  })
})
