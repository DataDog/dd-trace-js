'use strict'

/** @typedef {Record<string, unknown>} Carrier */
/** @typedef {string | Buffer} PathwayValue */

const FIELD_READ = 1
const FIELD_WRITE = 2
const FIELD_HAS = 4
const FIELD_DELETE = 8
const FIELD_NAME_LENGTH = 16

const b3FlagsHeader = 'x-b3-flags'
const b3Header = 'b3'
const b3SampledHeader = 'x-b3-sampled'
const b3SpanIdHeader = 'x-b3-spanid'
const b3TraceIdHeader = 'x-b3-traceid'
const baggageHeader = 'baggage'
const datadogOriginHeader = 'x-datadog-origin'
const datadogParentIdHeader = 'x-datadog-parent-id'
const datadogSamplingPriorityHeader = 'x-datadog-sampling-priority'
const datadogTagsHeader = 'x-datadog-tags'
const datadogTraceIdHeader = 'x-datadog-trace-id'
const dsmBase64Header = 'dd-pathway-ctx-base64'
const dsmBinaryHeader = 'dd-pathway-ctx'
const sqsdHeader = 'x-aws-sqsd-attr-_datadog'
const traceparentHeader = 'traceparent'
const tracestateHeader = 'tracestate'

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
 * @property {((carrier: Carrier) => Value | undefined) | undefined} read
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
 * @param {((carrier: Carrier) => Value | undefined) | undefined} read
 * @param {number} operations
 * @returns {CarrierField<Value>}
 */
function defineField (fieldName, headerName, read, operations) {
  return defineCapability(fieldName, operations, {
    read,

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

/** @param {Carrier} carrier */
function readB3Flags (carrier) { return readLastText(carrier[b3FlagsHeader]) }

/** @param {Carrier} carrier */
function readB3 (carrier) { return readLastText(carrier[b3Header]) }

/** @param {Carrier} carrier */
function readB3Sampled (carrier) { return readLastText(carrier[b3SampledHeader]) }

/** @param {Carrier} carrier */
function readB3SpanId (carrier) { return readLastText(carrier[b3SpanIdHeader]) }

/** @param {Carrier} carrier */
function readB3TraceId (carrier) { return readLastText(carrier[b3TraceIdHeader]) }

/** @param {Carrier} carrier */
function readBaggage (carrier) { return readListText(carrier[baggageHeader]) }

/** @param {Carrier} carrier */
function readDatadogOrigin (carrier) { return readLastText(carrier[datadogOriginHeader]) }

/** @param {Carrier} carrier */
function readDatadogParentId (carrier) { return readLastText(carrier[datadogParentIdHeader]) }

/** @param {Carrier} carrier */
function readDatadogSamplingPriority (carrier) { return readLastText(carrier[datadogSamplingPriorityHeader]) }

/** @param {Carrier} carrier */
function readDatadogTags (carrier) { return readListText(carrier[datadogTagsHeader]) }

/** @param {Carrier} carrier */
function readDatadogTraceId (carrier) { return readLastText(carrier[datadogTraceIdHeader]) }

/** @param {Carrier} carrier */
function readDsmBase64 (carrier) { return readLastPathway(carrier[dsmBase64Header]) }

/** @param {Carrier} carrier */
function readDsmBinary (carrier) { return readLastPathway(carrier[dsmBinaryHeader]) }

/** @param {Carrier} carrier */
function readSqsd (carrier) { return readLastText(carrier[sqsdHeader]) }

/** @param {Carrier} carrier */
function readTraceparent (carrier) { return readUniqueText(carrier[traceparentHeader]) }

/** @param {Carrier} carrier */
function readTracestate (carrier) { return readListText(carrier[tracestateHeader]) }

const datadogTraceId = defineField(
  'datadogTraceId',
  datadogTraceIdHeader,
  readDatadogTraceId,
  FIELD_READ | FIELD_WRITE
)
const datadogParentId = defineField(
  'datadogParentId',
  datadogParentIdHeader,
  readDatadogParentId,
  FIELD_READ | FIELD_WRITE | FIELD_DELETE
)
const datadogOrigin = defineField(
  'datadogOrigin',
  datadogOriginHeader,
  readDatadogOrigin,
  FIELD_READ | FIELD_WRITE
)
const datadogSamplingPriority = defineField(
  'datadogSamplingPriority',
  datadogSamplingPriorityHeader,
  readDatadogSamplingPriority,
  FIELD_READ | FIELD_WRITE
)
defineField('datadogTags', datadogTagsHeader, readDatadogTags, FIELD_READ | FIELD_WRITE)
defineField('baggage', baggageHeader, readBaggage, FIELD_READ | FIELD_WRITE)
const b3TraceId = defineField('b3TraceId', b3TraceIdHeader, readB3TraceId, FIELD_READ | FIELD_WRITE)
const b3SpanId = defineField('b3SpanId', b3SpanIdHeader, readB3SpanId, FIELD_READ | FIELD_WRITE)
const b3ParentId = defineField('b3ParentId', 'x-b3-parentspanid', undefined, FIELD_WRITE)
const b3Sampled = defineField('b3Sampled', b3SampledHeader, readB3Sampled, FIELD_READ | FIELD_WRITE)
const b3Flags = defineField('b3Flags', b3FlagsHeader, readB3Flags, FIELD_READ | FIELD_WRITE)
const b3 = defineField('b3', b3Header, readB3, FIELD_READ | FIELD_WRITE)
defineField('sqsd', sqsdHeader, readSqsd, FIELD_READ)
const traceparent = defineField('traceparent', traceparentHeader, readTraceparent, FIELD_READ | FIELD_WRITE)
const tracestate = defineField('tracestate', tracestateHeader, readTracestate, FIELD_READ | FIELD_WRITE)
const dsmBase64 = defineField(
  'dsmBase64',
  dsmBase64Header,
  readDsmBase64,
  FIELD_READ | FIELD_WRITE | FIELD_HAS | FIELD_NAME_LENGTH
)
const dsmBinary = defineField('dsmBinary', dsmBinaryHeader, readDsmBinary, FIELD_READ | FIELD_HAS)

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
 * @property {typeof readBaggage} readBaggage
 * @property {typeof readB3} readB3
 * @property {typeof readB3Flags} readB3Flags
 * @property {typeof readB3Sampled} readB3Sampled
 * @property {typeof readB3SpanId} readB3SpanId
 * @property {typeof readB3TraceId} readB3TraceId
 * @property {typeof readDatadogOrigin} readDatadogOrigin
 * @property {typeof readDatadogParentId} readDatadogParentId
 * @property {typeof readDatadogSamplingPriority} readDatadogSamplingPriority
 * @property {typeof readDatadogTags} readDatadogTags
 * @property {typeof readDatadogTraceId} readDatadogTraceId
 * @property {typeof readDsmBase64} readDsmBase64
 * @property {typeof readDsmBinary} readDsmBinary
 * @property {(carrier: Carrier, target: Record<string, string>) => void} readLegacyBaggage
 * @property {typeof readSqsd} readSqsd
 * @property {typeof readTraceparent} readTraceparent
 * @property {typeof readTracestate} readTracestate
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
