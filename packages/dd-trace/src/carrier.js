'use strict'

/** @typedef {Record<string, unknown>} Carrier */
/** @typedef {string | Buffer} PathwayValue */

const FIELD_READ = 1
const FIELD_WRITE = 2
const FIELD_HAS = 4
const FIELD_DELETE = 8
const FIELD_NAME_LENGTH = 16

/** @type {Record<string, unknown>} */
const carrierOperations = {}

/**
 * @typedef {object} CarrierCapability
 * @property {unknown} [read]
 * @property {unknown} [write]
 * @property {unknown} [has]
 * @property {unknown} [delete]
 * @property {unknown} [nameLength]
 */

/**
 * @template Value
 * @typedef {object} CarrierField
 * @property {(carrier: Carrier) => Value | undefined} read
 * @property {(carrier: Carrier, value: Value) => void} write
 * @property {(carrier: Carrier) => boolean} has
 * @property {(carrier: Carrier) => void} delete
 * @property {(carrier: Carrier, target: Carrier) => void} copy
 * @property {number} nameLength
 */

/**
 * @template {CarrierCapability} Capability
 * @param {string} name
 * @param {number} operations
 * @param {Capability} capability
 * @returns {Capability}
 */
function defineCapability (name, operations, capability) {
  const suffix = name[0].toUpperCase() + name.slice(1)
  if (operations & FIELD_READ) carrierOperations[`read${suffix}`] = capability.read
  if (operations & FIELD_WRITE) carrierOperations[`write${suffix}`] = capability.write
  if (operations & FIELD_HAS) carrierOperations[`has${suffix}`] = capability.has
  if (operations & FIELD_DELETE) carrierOperations[`delete${suffix}`] = capability.delete
  if (operations & FIELD_NAME_LENGTH) carrierOperations[`${name}NameLength`] = capability.nameLength
  return capability
}

/**
 * @template Value
 * @param {string} fieldName
 * @param {string} headerName
 * @param {(value: unknown) => Value | undefined} resolve
 * @param {number} operations
 * @returns {CarrierField<Value>}
 */
function defineField (fieldName, headerName, resolve, operations) {
  return defineCapability(fieldName, operations, {
    /**
     * @param {Carrier} carrier
     * @returns {Value | undefined}
     */
    read (carrier) {
      return resolve(carrier[headerName])
    },

    /**
     * @param {Carrier} carrier
     * @param {Value} value
     * @returns {void}
     */
    write (carrier, value) {
      carrier[headerName] = value
    },

    /**
     * @param {Carrier} carrier
     * @returns {boolean}
     */
    has (carrier) {
      return headerName in carrier
    },

    /**
     * @param {Carrier} carrier
     * @returns {void}
     */
    delete (carrier) {
      delete carrier[headerName]
    },

    /**
     * @param {Carrier} carrier
     * @param {Carrier} target
     * @returns {void}
     */
    copy (carrier, target) {
      if (Object.hasOwn(carrier, headerName)) target[headerName] = carrier[headerName]
    },

    nameLength: headerName.length,
  })
}

/**
 * Skipping non-strings keeps a Symbol or a throwing `toString` from aborting
 * extraction, which discards the whole context rather than one field.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readListText (value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return

  let joined = ''
  let first = true

  for (const item of value) {
    if (typeof item !== 'string') continue
    if (first) {
      joined = item
      first = false
    } else {
      joined += `,${item}`
    }
  }

  return joined
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readLastText (value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return

  let result
  for (let i = value.length - 1; i >= 0; i--) {
    if (typeof value[i] === 'string') {
      result = value[i]
      break
    }
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readUniqueText (value) {
  let result
  if (typeof value === 'string') {
    result = value
  } else if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    result = value[0]
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {PathwayValue | undefined}
 */
function readLastPathway (value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value
  if (!Array.isArray(value)) return

  let result
  for (let i = value.length - 1; i >= 0; i--) {
    const item = value[i]
    if (typeof item === 'string' || Buffer.isBuffer(item)) {
      result = item
      break
    }
  }
  return result
}

const datadogTraceId = defineField(
  'datadogTraceId',
  'x-datadog-trace-id',
  readLastText,
  FIELD_READ | FIELD_WRITE
)
const datadogParentId = defineField(
  'datadogParentId',
  'x-datadog-parent-id',
  readLastText,
  FIELD_READ | FIELD_WRITE | FIELD_DELETE
)
const datadogOrigin = defineField(
  'datadogOrigin',
  'x-datadog-origin',
  readLastText,
  FIELD_READ | FIELD_WRITE
)
const datadogSamplingPriority = defineField(
  'datadogSamplingPriority',
  'x-datadog-sampling-priority',
  readLastText,
  FIELD_READ | FIELD_WRITE
)
defineField('datadogTags', 'x-datadog-tags', readListText, FIELD_READ | FIELD_WRITE)
defineField('baggage', 'baggage', readListText, FIELD_READ | FIELD_WRITE)
const b3TraceId = defineField('b3TraceId', 'x-b3-traceid', readLastText, FIELD_READ | FIELD_WRITE)
const b3SpanId = defineField('b3SpanId', 'x-b3-spanid', readLastText, FIELD_READ | FIELD_WRITE)
const b3ParentId = defineField('b3ParentId', 'x-b3-parentspanid', readLastText, FIELD_WRITE)
const b3Sampled = defineField('b3Sampled', 'x-b3-sampled', readLastText, FIELD_READ | FIELD_WRITE)
const b3Flags = defineField('b3Flags', 'x-b3-flags', readLastText, FIELD_READ | FIELD_WRITE)
const b3 = defineField('b3', 'b3', readLastText, FIELD_READ | FIELD_WRITE)
defineField('sqsd', 'x-aws-sqsd-attr-_datadog', readLastText, FIELD_READ)
const traceparent = defineField('traceparent', 'traceparent', readUniqueText, FIELD_READ | FIELD_WRITE)
const tracestate = defineField('tracestate', 'tracestate', readListText, FIELD_READ | FIELD_WRITE)
const dsmBase64 = defineField(
  'dsmBase64',
  'dd-pathway-ctx-base64',
  readLastPathway,
  FIELD_READ | FIELD_WRITE | FIELD_HAS | FIELD_NAME_LENGTH
)
const dsmBinary = defineField('dsmBinary', 'dd-pathway-ctx', readLastPathway, FIELD_READ | FIELD_HAS)

const legacyBaggagePrefix = 'ot-baggage-'
// RFC 7230 `token`, compatible with Node.js header-name validation.
const httpHeaderNameExpr = /^[0-9A-Za-z!#$%&'*+\-.^_`|~]+$/

defineCapability('legacyBaggage', FIELD_READ | FIELD_WRITE, {
  /**
   * @param {Record<string, string> | undefined} carrier
   * @param {string} key
   * @param {string} value
   * @returns {Record<string, string> | undefined}
   */
  write (carrier, key, value) {
    const name = legacyBaggagePrefix + key
    if (!httpHeaderNameExpr.test(name)) return

    carrier ??= {}
    carrier[name] = value
    return carrier
  },

  /**
   * @param {Carrier} carrier
   * @param {Record<string, string>} target
   * @returns {void}
   */
  read (carrier, target) {
    for (const name of Object.keys(carrier)) {
      if (!name.startsWith(legacyBaggagePrefix)) continue
      const key = name.slice(legacyBaggagePrefix.length)
      if (!key) continue
      const value = readLastText(carrier[name])
      if (value !== undefined) target[key] = value
    }
  },
})

const textMapLogFields = [
  datadogTraceId,
  datadogParentId,
  datadogSamplingPriority,
  datadogOrigin,
  b3TraceId,
  b3SpanId,
  b3ParentId,
  b3Sampled,
  b3Flags,
  b3,
  traceparent,
  tracestate,
]
const dsmLogFields = [dsmBinary, dsmBase64]

/**
 * @param {Carrier} carrier
 * @param {Array<Pick<CarrierField<unknown>, 'copy'>>} selectedFields
 * @returns {Carrier}
 */
function pick (carrier, selectedFields) {
  /** @type {Carrier} */
  const result = {}
  for (const field of selectedFields) field.copy(carrier, result)
  return result
}

/**
 * @param {Carrier} carrier
 * @returns {Carrier}
 */
function pickTextMap (carrier) {
  return pick(carrier, textMapLogFields)
}

/**
 * @param {Carrier} carrier
 * @returns {Carrier}
 */
function pickDsm (carrier) {
  return pick(carrier, dsmLogFields)
}

/**
 * @typedef {object} CarrierOperations
 * @property {typeof datadogParentId.delete} deleteDatadogParentId
 * @property {typeof dsmBase64.nameLength} dsmBase64NameLength
 * @property {typeof dsmBase64.has} hasDsmBase64
 * @property {typeof dsmBinary.has} hasDsmBinary
 * @property {typeof pickDsm} pickDsm
 * @property {typeof pickTextMap} pickTextMap
 * @property {(carrier: Carrier) => string | undefined} readBaggage
 * @property {typeof b3.read} readB3
 * @property {typeof b3Flags.read} readB3Flags
 * @property {typeof b3Sampled.read} readB3Sampled
 * @property {typeof b3SpanId.read} readB3SpanId
 * @property {typeof b3TraceId.read} readB3TraceId
 * @property {typeof datadogOrigin.read} readDatadogOrigin
 * @property {typeof datadogParentId.read} readDatadogParentId
 * @property {typeof datadogSamplingPriority.read} readDatadogSamplingPriority
 * @property {(carrier: Carrier) => string | undefined} readDatadogTags
 * @property {typeof datadogTraceId.read} readDatadogTraceId
 * @property {typeof dsmBase64.read} readDsmBase64
 * @property {typeof dsmBinary.read} readDsmBinary
 * @property {(carrier: Carrier, target: Record<string, string>) => void} readLegacyBaggage
 * @property {(carrier: Carrier) => string | undefined} readSqsd
 * @property {typeof traceparent.read} readTraceparent
 * @property {typeof tracestate.read} readTracestate
 * @property {(carrier: Carrier, value: string) => void} writeBaggage
 * @property {typeof b3.write} writeB3
 * @property {typeof b3Flags.write} writeB3Flags
 * @property {typeof b3ParentId.write} writeB3ParentId
 * @property {typeof b3Sampled.write} writeB3Sampled
 * @property {typeof b3SpanId.write} writeB3SpanId
 * @property {typeof b3TraceId.write} writeB3TraceId
 * @property {typeof datadogOrigin.write} writeDatadogOrigin
 * @property {typeof datadogParentId.write} writeDatadogParentId
 * @property {typeof datadogSamplingPriority.write} writeDatadogSamplingPriority
 * @property {(carrier: Carrier, value: string) => void} writeDatadogTags
 * @property {typeof datadogTraceId.write} writeDatadogTraceId
 * @property {typeof dsmBase64.write} writeDsmBase64
 * @property {(carrier: Record<string, string> | undefined, key: string, value: string) =>
 *   Record<string, string> | undefined} writeLegacyBaggage
 * @property {typeof traceparent.write} writeTraceparent
 * @property {typeof tracestate.write} writeTracestate
 */

carrierOperations.pickDsm = pickDsm
carrierOperations.pickTextMap = pickTextMap

module.exports = /** @type {CarrierOperations} */ (carrierOperations)
