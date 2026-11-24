'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()

// Four original region/override cases plus strict parsing boundaries that differ from general tracer booleans.
describe('Lambda metrics FIPS source contract', () => {
  for (const [region, override, enabled] of [
    ['us-gov-west-1', undefined, true], ['us-east-1', undefined, false],
    ['us-east-1', 'true', true], ['us-gov-east-1', 'false', false],
    ['us-east-1', 'TrUe', true], ['us-gov-east-1', '1', false],
    ['us-gov-east-1', '', false], ['us-gov-east-1', 'garbage', false],
    [undefined, undefined, false], [undefined, 'true', true],
  ]) {
    it(`region=${region}, override=${override}: ${enabled}`, () => {
      const env = { AWS_REGION: region, DD_LAMBDA_FIPS_MODE: override }
      const result = proxyquire('../../src/fips', {
        '../../dd-trace/src/config/helper': { getEnvironmentVariable: key => env[key] },
      })
      assert.deepStrictEqual(result, { AWS_REGION: region ?? '', FIPS_MODE_ENABLED: enabled })
    })
  }
})
