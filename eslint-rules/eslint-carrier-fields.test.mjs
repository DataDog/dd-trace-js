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
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'const { readDatadogTraceId } = carrierOperations; readDatadogTraceId(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
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
      code: 'const { readDatadogTraceId } = require("../carrier"); ' +
        'function extractDatadog (carrier) { return readDatadogTraceId(carrier) } extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'const { readDatadogTraceId } = require("../carrier"); ' +
        'const extractDatadog = carrier => readDatadogTraceId(carrier); extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'const { readDatadogTraceId } = require("../carrier"); ' +
        'function extractDatadog (carrier) { function identity (carrier) { return carrier } ' +
        'return readDatadogTraceId(carrier) } extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extract (carrier) { if (carrier === null) return }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'let value = carrier; value = input; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'let value = carrier; if (condition) { value = input } else { value = {} } readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'let value = carrier; do { value = input } while (condition); readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extractDatadog (carrier) { let value = carrier; value = input; ' +
        'return readSingleton(value, key) } extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extractDatadog (carrier) { let value = carrier; value = input; return value } ' +
        'extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extract (carrier) { let value = carrier; const read = () => readSingleton(value, key); ' +
        'value = input; return read }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function extract (carrier) { const value = carrier; ' +
        'return () => { const value = input; return readSingleton(value, key) } }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'const first = second; const second = first; readSingleton(first, key)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function outer () { function first () { return second() } ' +
        'function second () { return first() } sink(first()) }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'function outer (carrier) { let get = () => carrier; get = () => input; sink(get()) }',
      options: [{ strictCarrierIdentifiers: true }],
    },
    {
      code: 'let first = carrier; first += 1; let second = carrier; second++; ' +
        'let third = carrier; third &&= input; ' +
        'readSingleton(first, key); readSingleton(second, key); readSingleton(third, key)',
      options: [{ strictCarrierIdentifiers: true }],
    },
    { code: 'carrier ??= {}', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'function inject (carrier) { return carrier }', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'channel.publish({ carrier })', options: [{ strictCarrierIdentifiers: true }] },
    { code: 'carrier[key] = value' },
    { code: 'carrier.foo = value' },
    { code: 'const context = { traceparent: value }' },
    { code: 'function create () { return { traceparent: value } }' },
    { code: 'consume({ traceparent: value })' },
    { code: 'config["baggage"]' },
    { code: 'settings["nested"]["baggage"]' },
    { code: '"b3" in codecs' },
    { code: 'Object.hasOwn(config, "traceparent")' },
    { code: 'const { baggage } = config' },
    { code: 'Reflect.get(...args)' },
    { code: 'headers.hasOwnProperty()' },
    { code: 'headers.hasOwnProperty(...keys)' },
    { code: 'const key = `not-a-header`; config[key]' },
    { code: 'const { ...operations } = require("../carrier")' },
    { code: 'const value = request.headers["x-datadog-endpoint-scan"]' },
    { code: 'headers["access-control-allow-headers"]' },
  ],

  invalid: [
    {
      code: 'carrier["x-datadog-trace-id"] = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'carrier[TRACE_HEADER] = value',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const key = key; carrier[key] = value',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const traceIdHeader = "x-datadog-trace-id"; carrier[traceIdHeader] = value',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const header = `traceparent`; headers[header] = value',
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
      code: 'const input = { headers: { traceparent: value } }',
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
      code: 'Object.hasOwn(headers, "traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.has(attributes, "baggage")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Object.defineProperty(headers, "traceparent", descriptor)',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Object.getOwnPropertyDescriptor(headers, "traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.get(headers, "traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.set(headers, "traceparent", value)',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.deleteProperty(headers, "traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.defineProperty(headers, "traceparent", descriptor)',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Reflect.getOwnPropertyDescriptor(headers, "traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Object.assign(carrier, { traceparent: value })',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Object.defineProperties(headers, { traceparent: descriptor })',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'headers.hasOwnProperty("traceparent")',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'const { traceparent } = headers',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: '({ traceparent } = headers)',
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
      code: 'function extractDatadog (carrier) { return carrier[key] } extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function identity (carrier) { return carrier } const value = identity(carrier); readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [
        { messageId: 'noDirectCarrierAccess', line: 1, column: 71, endColumn: 78 },
        { messageId: 'noDirectCarrierAccess', line: 1, column: 95, endColumn: 100 },
      ],
    },
    {
      code: 'function caller (carrier) { sink(identity(carrier)) } ' +
        'function identity (carrier) { return carrier } caller(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [
        { messageId: 'noDirectCarrierAccess', line: 1, column: 34, endColumn: 51 },
        { messageId: 'noDirectCarrierAccess', line: 1, column: 43, endColumn: 50 },
      ],
    },
    {
      code: 'function identity (carrier) { return carrier } ' +
        'function caller (carrier) { sink(identity(carrier)) } caller(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [
        { messageId: 'noDirectCarrierAccess', line: 1, column: 81, endColumn: 98 },
        { messageId: 'noDirectCarrierAccess', line: 1, column: 90, endColumn: 97 },
      ],
    },
    {
      code: 'function identity (carrier) { if (condition) return carrier } identity(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extractDatadog (carrier) {} extractDatadog = readSingleton; extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extractDatadog (value) { return value[key] } extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extractDatadog (carrier) { const value = carrier; return readSingleton(value, key) } ' +
        'extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extractDatadog (carrier) { let value; value = carrier; return readSingleton(value, key) } ' +
        'extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extract (carrier) { const value = carrier; return () => readSingleton(value, key) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extract (carrier) { const value = carrier; return () => value[key] }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extract (carrier) { const first = carrier; const second = first; ' +
        'return () => readSingleton(second, key) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function outer (carrier) { function get () { return carrier } sink(get()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 68, endColumn: 73 }],
    },
    {
      code: 'function outer (carrier) { function get () { return carrier } ' +
        'const value = get(); sink(value) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 89, endColumn: 94 }],
    },
    {
      code: 'function outer (carrier) { function first () { return second() } ' +
        'function second () { return carrier } sink(first()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 109, endColumn: 116 }],
    },
    {
      code: 'function outer (carrier) { function second () { return carrier } ' +
        'function first () { return second() } sink(first()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 109, endColumn: 116 }],
    },
    {
      code: 'function outer (carrier, condition) { function get () { return carrier } ' +
        'let value = get(); if (condition) sink(value) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 113, endColumn: 118 }],
    },
    {
      code: 'function outer (carrier) { const get = () => carrier; sink(get()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 60, endColumn: 65 }],
    },
    {
      code: 'function outer (carrier) { let get = () => carrier; sink(get()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 58, endColumn: 63 }],
    },
    {
      code: 'function outer (carrier) { const get = function () { return carrier }; sink(get()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 77, endColumn: 82 }],
    },
    {
      code: 'function outer (carrier, condition) { function first () { return condition ? carrier : second() } ' +
        'function second () { return first() } sink(second()) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess', line: 1, column: 142, endColumn: 150 }],
    },
    {
      code: 'let value = carrier; if (condition) value = input; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'let value = carrier; while (condition) value = input; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'let value = input; if (condition) value = carrier; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'let value = carrier; value ??= input; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extract (carrier) { return; const value = carrier; readSingleton(value, key) }',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function identity (carrier) { let value = carrier; if (condition) value = input; return value } ' +
        'identity(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const value = input || carrier; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const value = condition ? carrier : input; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const value = condition ? input : carrier; readSingleton(value, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const extractDatadog = () => {}; extractDatadog(carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'function extractDatadog (carrier) {} extractDatadog(...carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'header in carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: '"traceparent" in headers',
      errors: [{ messageId: 'useCarrierField' }],
    },
    {
      code: 'Object.hasOwn(carrier, key)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'consume(...carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const { key } = carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const { traceparent, ...rest } = carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'useCarrierField' }, { messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const { traceparent, key } = carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'useCarrierField' }, { messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: '({ key } = carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const {} = carrier',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: '({} = carrier)',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'injectedCarrier.foo = value',
      options: [{ strictCarrierIdentifiers: true }],
      errors: [{ messageId: 'noDirectCarrierAccess' }],
    },
    {
      code: 'const { writeDatadogTraceId: writeTraceId } = require("../carrier")',
      errors: [{ messageId: 'aliasCarrierOperation' }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'carrierOperations.writeDatadogTraceId(carrier, value)',
      errors: [{ messageId: 'useDirectCarrierOperation' }],
    },
    {
      code: 'const carrierOperations = require("../carrier"); ' +
        'const writeTraceId = carrierOperations.writeDatadogTraceId',
      errors: [{ messageId: 'aliasCarrierOperation' }],
    },
  ],
})

// eslint-disable-next-line no-console
console.log('eslint-carrier-fields tests passed')
