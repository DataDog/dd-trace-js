'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { computeIntakeUrl, INTAKE_URLS, INTAKE_PATH } = require('../../../src/exporters/agentless/intake')

require('../../setup/core')

describe('agentless intake', () => {
  describe('computeIntakeUrl', () => {
    for (const [site, expected] of Object.entries(INTAKE_URLS)) {
      it(`maps the ${site} site to its intake host`, () => {
        assert.strictEqual(computeIntakeUrl(site), expected)
      })
    }

    it('defaults to the datadoghq.com intake', () => {
      assert.strictEqual(computeIntakeUrl(), INTAKE_URLS['datadoghq.com'])
    })

    it('lowercases the site before lookup', () => {
      assert.strictEqual(computeIntakeUrl('US3.DataDogHQ.com'), INTAKE_URLS['us3.datadoghq.com'])
    })

    for (const [site, expected] of [
      ['ap3.datadoghq.com', 'https://browser-intake-ap3-datadoghq.com'],
      ['ddog-gov.com', 'https://browser-intake-ddog-gov.com'],
      ['us2.ddog-gov.com', 'https://browser-intake-us2-ddog-gov.com'],
    ]) {
      it(`falls back to the browser-intake host for the unknown ${site} site`, () => {
        assert.strictEqual(computeIntakeUrl(site), expected)
      })
    }
  })

  it('targets the JSON span intake path', () => {
    assert.strictEqual(INTAKE_PATH, '/api/v2/spans')
  })
})
