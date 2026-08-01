'use strict'

/** @typedef {Record<string, unknown>} Carrier */
/** @typedef {string | Buffer} PathwayValue */

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
 * @template Value
 * @param {string} name
 * @param {(value: unknown) => Value | undefined} resolve
 * @returns {CarrierField<Value>}
 */
function defineField (name, resolve) {
  return {
    /**
     * @param {Carrier} carrier
     * @returns {Value | undefined}
     */
    read (carrier) {
      return resolve(carrier[name])
    },

    /**
     * @param {Carrier} carrier
     * @param {Value} value
     * @returns {void}
     */
    write (carrier, value) {
      carrier[name] = value
    },

    /**
     * @param {Carrier} carrier
     * @returns {boolean}
     */
    has (carrier) {
      return name in carrier
    },

    /**
     * @param {Carrier} carrier
     * @returns {void}
     */
    delete (carrier) {
      delete carrier[name]
    },

    /**
     * @param {Carrier} carrier
     * @param {Carrier} target
     * @returns {void}
     */
    copy (carrier, target) {
      if (Object.hasOwn(carrier, name)) target[name] = carrier[name]
    },

    nameLength: name.length,
  }
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

const datadogTraceId = defineField('x-datadog-trace-id', readLastText)
const datadogParentId = defineField('x-datadog-parent-id', readLastText)
const datadogOrigin = defineField('x-datadog-origin', readLastText)
const datadogSamplingPriority = defineField('x-datadog-sampling-priority', readLastText)
const datadogTags = defineField('x-datadog-tags', readListText)
const baggage = defineField('baggage', readListText)
const b3TraceId = defineField('x-b3-traceid', readLastText)
const b3SpanId = defineField('x-b3-spanid', readLastText)
const b3ParentId = defineField('x-b3-parentspanid', readLastText)
const b3Sampled = defineField('x-b3-sampled', readLastText)
const b3Flags = defineField('x-b3-flags', readLastText)
const b3 = defineField('b3', readLastText)
const sqsd = defineField('x-aws-sqsd-attr-_datadog', readLastText)
const traceparent = defineField('traceparent', readUniqueText)
const tracestate = defineField('tracestate', readListText)
const dsmBase64 = defineField('dd-pathway-ctx-base64', readLastPathway)
const dsmBinary = defineField('dd-pathway-ctx', readLastPathway)

const legacyBaggagePrefix = 'ot-baggage-'
// RFC 7230 `token`, compatible with Node.js header-name validation.
const httpHeaderNameExpr = /^[0-9A-Za-z!#$%&'*+\-.^_`|~]+$/

const legacyBaggage = {
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
}

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

module.exports = {
  deleteDatadogParentId: datadogParentId.delete,
  dsmBase64NameLength: dsmBase64.nameLength,
  hasDsmBase64: dsmBase64.has,
  hasDsmBinary: dsmBinary.has,
  pickDsm,
  pickTextMap,
  readBaggage: baggage.read,
  readB3: b3.read,
  readB3Flags: b3Flags.read,
  readB3Sampled: b3Sampled.read,
  readB3SpanId: b3SpanId.read,
  readB3TraceId: b3TraceId.read,
  readDatadogOrigin: datadogOrigin.read,
  readDatadogParentId: datadogParentId.read,
  readDatadogSamplingPriority: datadogSamplingPriority.read,
  readDatadogTags: datadogTags.read,
  readDatadogTraceId: datadogTraceId.read,
  readDsmBase64: dsmBase64.read,
  readDsmBinary: dsmBinary.read,
  readLegacyBaggage: legacyBaggage.read,
  readSqsd: sqsd.read,
  readTraceparent: traceparent.read,
  readTracestate: tracestate.read,
  writeBaggage: baggage.write,
  writeB3: b3.write,
  writeB3Flags: b3Flags.write,
  writeB3ParentId: b3ParentId.write,
  writeB3Sampled: b3Sampled.write,
  writeB3SpanId: b3SpanId.write,
  writeB3TraceId: b3TraceId.write,
  writeDatadogOrigin: datadogOrigin.write,
  writeDatadogParentId: datadogParentId.write,
  writeDatadogSamplingPriority: datadogSamplingPriority.write,
  writeDatadogTags: datadogTags.write,
  writeDatadogTraceId: datadogTraceId.write,
  writeDsmBase64: dsmBase64.write,
  writeLegacyBaggage: legacyBaggage.write,
  writeTraceparent: traceparent.write,
  writeTracestate: tracestate.write,
}
