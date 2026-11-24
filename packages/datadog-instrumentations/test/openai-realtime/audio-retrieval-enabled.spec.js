'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')

const NAME = 'DD_OPENAI_REALTIME_SIDEBAND_AUDIO_RETRIEVAL_ENABLED'

/** @param {{ fleet?: Record<string, string>, local?: Record<string, string> }} sources */
function fromSources ({ fleet = {}, local = {} }) {
  const StableConfig = sinon.stub().callsFake(function () {
    this.localEntries = local
    this.fleetEntries = fleet
    this.warnings = []
  })
  const helper = proxyquire('../../../dd-trace/src/config/helper', {
    '../serverless': { IS_SERVERLESS: false },
    './stable': StableConfig,
  })
  return helper.getValueFromEnvSources(NAME)
}

describe('OpenAI Realtime sideband audio retrieval configuration', () => {
  afterEach(() => { delete process.env[NAME] })

  it('is enabled by default', () => {
    assert.strictEqual(getValueFromEnvSources(NAME), true)
    assert.strictEqual(fromSources({}), true)
  })

  it('accepts explicit boolean values from the environment', () => {
    for (const value of ['false', 'FALSE', '0']) {
      process.env[NAME] = value
      assert.strictEqual(getValueFromEnvSources(NAME), false, value)
    }
    for (const value of ['true', '1', '', 'invalid']) {
      process.env[NAME] = value
      assert.strictEqual(getValueFromEnvSources(NAME), true, value)
    }
  })

  it('honors local stable configuration', () => {
    assert.strictEqual(fromSources({ local: { [NAME]: 'false' } }), false)
  })

  it('honors fleet stable configuration over environment and local settings', () => {
    process.env[NAME] = 'false'
    assert.strictEqual(fromSources({ fleet: { [NAME]: 'true' }, local: { [NAME]: 'false' } }), true)
    process.env[NAME] = 'true'
    assert.strictEqual(fromSources({ fleet: { [NAME]: 'false' } }), false)
  })
})
