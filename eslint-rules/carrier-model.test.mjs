import assert from 'node:assert/strict'

import { parseCarrierModel } from './carrier-model.mjs'

const prefix = "const legacyBaggagePrefix = 'ot-baggage-'\n"

const model = parseCarrierModel(`${prefix}
  const traceparent = defineField(
    'traceparent',
    'traceparent',
    resolve,
    operations
  )
  defineField('baggage', 'baggage', resolve, operations)
`)

assert.strictEqual(model.legacyBaggagePrefix, 'ot-baggage-')
assert.deepStrictEqual([...model.propagationHeaders], ['traceparent', 'baggage'])

const constantModel = parseCarrierModel(`${prefix}
  const traceparentHeader = 'traceparent'
  const traceparent = defineField('traceparent', traceparentHeader, resolve, operations)
`)

assert.deepStrictEqual([...constantModel.propagationHeaders], ['traceparent'])

assert.throws(() => parseCarrierModel('const ='), /Unable to parse/)

assert.throws(
  () => parseCarrierModel(`${prefix}const traceparent = defineField('tracestate', 'tracestate')`),
  /top-level statement or matching constant/
)

assert.throws(
  () => parseCarrierModel(`${prefix}defineField(...field)`),
  /must use string literals/
)

assert.throws(
  () => parseCarrierModel(`${prefix}
    defineField('traceparent', 'traceparent')
    defineField('duplicate', 'traceparent')
  `),
  /Duplicate carrier field or header declaration/
)

assert.throws(
  () => parseCarrierModel(`${prefix}function register () { defineField('traceparent', 'traceparent') }`),
  /top-level statement/
)

assert.throws(
  () => parseCarrierModel(`${prefix}
    let traceparentHeader = 'traceparent'
    const traceparent = defineField('traceparent', traceparentHeader)
  `),
  /top-level string constants/
)

assert.throws(
  () => parseCarrierModel(`
    const legacyBaggagePrefix = getPrefix()
    defineField('traceparent', 'traceparent')
  `),
  /legacyBaggagePrefix must be one top-level string literal/
)

assert.throws(() => parseCarrierModel(prefix), /Unable to discover/)
assert.throws(() => parseCarrierModel("defineField('traceparent', 'traceparent')"), /Unable to discover/)

// eslint-disable-next-line no-console
console.log('carrier-model tests passed')
