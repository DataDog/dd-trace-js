import { RuleTester } from 'eslint'
import rule from './eslint-carrier-fields.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-carrier-fields', rule, {
  valid: [
    {
      code: 'const { writeDatadogTraceId } = require("../carrier"); writeDatadogTraceId(carrier, value)',
      options: [{ requireDirectOperations: true, strictCarrierIdentifiers: true }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'const { readDatadogTraceId } = carrierOperations; readDatadogTraceId(carrier)',
      options: [{ requireDirectOperations: true, strictCarrierIdentifiers: true }],
    },
    {
      code: 'const { pickTextMap } = require("../carrier"); pickTextMap(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extract (carrier) { return this._extractDatadogContext(carrier) }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extract (carrier) { if (carrier === null) return }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    { code: 'carrier ??= {}', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'function inject (carrier) { return carrier }', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'channel.publish({ carrier })', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'carrier[key] = value' },
    { code: 'carrier.foo = value' },
    { code: 'const context = { traceparent: value }' },
    { code: 'const value = request.headers["x-datadog-endpoint-scan"]' },
    { code: 'headers["access-control-allow-headers"]' },
  ],

  invalid: [
    {
      code: 'carrier["x-datadog-trace-id"] = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const traceIdHeader = "x-datadog-trace-id"; carrier[traceIdHeader] = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const value = request.headers["x-b3-traceid"]',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const carrier = { "dd-pathway-ctx-base64": value }',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'carrier.traceparent = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'headers.traceparent = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'request.headers.traceparent = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'attributes.traceparent = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const value = request.headers["traceparent"]',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const carrier = { traceparent: value }',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'tracer.extract("text_map", { traceparent: value })',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'carrier["ot-baggage-foo"] = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'carrier.baggage',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'carrier[key] = value',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'Object.keys(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'readSingleton(carrier, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'header in carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'injectedCarrier.foo = value',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'fields.datadogTraceId.write(carrier, value)',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'useDirectCarrierOperation' }],
    },
    {
      code: 'const carrierFields = require("../carrier"); carrierFields.datadogTraceId.write(carrier, value)',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'useDirectCarrierOperation' }],
    },
    {
      code: 'const fields = require("../carrier"); ' +
        'const { datadogTraceId } = fields; datadogTraceId.write(carrier, value)',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'useDirectCarrierOperation' }],
    },
    {
      code: 'const { writeDatadogTraceId: writeTraceId } = require("../carrier")',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'aliasCarrierOperation' }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'carrierOperations.writeDatadogTraceId(carrier, value)',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'useDirectCarrierOperation' }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'const writeTraceId = carrierOperations.writeDatadogTraceId',
      options: [{ requireDirectOperations: true }],
      errors: [{ messageId: 'aliasCarrierOperation' }],
    },
  ],
})

// eslint-disable-next-line no-console
console.log('eslint-carrier-fields tests passed')
