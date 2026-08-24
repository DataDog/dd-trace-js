'use strict'

const DEFAULT_MAX_COLLECTION_ENTRIES = 100_000
const DEFAULT_MAX_NESTING_DEPTH = 128
const DEFAULT_MAX_STRING_BYTES = 64 * 1024

/**
 * Parses JSON only after a no-allocation scan bounds nesting, strings, and collection cardinality.
 *
 * @param {Buffer|string} source encoded JSON
 * @param {object} [options] parser limits
 * @param {string} [options.label] value label used in errors
 * @param {number} [options.maxCollectionEntries] aggregate array/object entries
 * @param {number} [options.maxNestingDepth] maximum container nesting
 * @param {number} [options.maxStringBytes] maximum encoded string bytes
 * @returns {{collectionEntries: number, value: unknown}} parsed value and scanned cardinality
 */
function parseBoundedJson (source, options = {}) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source))
  const limits = {
    label: options.label || 'JSON',
    maxCollectionEntries: options.maxCollectionEntries || DEFAULT_MAX_COLLECTION_ENTRIES,
    maxNestingDepth: options.maxNestingDepth || DEFAULT_MAX_NESTING_DEPTH,
    maxStringBytes: options.maxStringBytes || DEFAULT_MAX_STRING_BYTES,
  }
  const collectionEntries = scanJson(buffer, limits)
  return {
    collectionEntries,
    value: JSON.parse(buffer.toString('utf8')),
  }
}

/**
 * Scans JSON bytes without creating one object per delimiter.
 *
 * @param {Buffer} buffer JSON bytes
 * @param {object} limits parser limits
 * @returns {number} aggregate collection entries
 */
function scanJson (buffer, limits) {
  const containerTypes = new Uint8Array(limits.maxNestingDepth)
  const arrayHasEntry = new Uint8Array(limits.maxNestingDepth)
  let collectionEntries = 0
  let depth = 0
  let escaped = false
  let inString = false
  let stringBytes = 0

  for (const byte of buffer) {
    if (inString) {
      stringBytes++
      if (stringBytes > limits.maxStringBytes) {
        throw new Error(`${limits.label} contains a string larger than ${limits.maxStringBytes} bytes.`)
      }
      if (escaped) {
        escaped = false
      } else if (byte === 0x5C) {
        escaped = true
      } else if (byte === 0x22) {
        inString = false
      }
      continue
    }

    if (byte === 0x22) {
      inString = true
      stringBytes = 0
      markArrayEntry()
      continue
    }

    const containerIndex = depth - 1
    if (containerIndex >= 0 && containerTypes[containerIndex] === 1 &&
      arrayHasEntry[containerIndex] === 0 && !isJsonWhitespace(byte) && byte !== 0x5D) {
      arrayHasEntry[containerIndex] = 1
      addEntry()
    }

    if (byte === 0x5B || byte === 0x7B) {
      if (depth >= limits.maxNestingDepth) {
        throw new Error(`${limits.label} nesting exceeds ${limits.maxNestingDepth}.`)
      }
      containerTypes[depth] = byte === 0x5B ? 1 : 2
      arrayHasEntry[depth] = 0
      depth++
    } else if (byte === 0x5D || byte === 0x7D) {
      if (depth > 0) depth--
    } else if (byte === 0x2C && containerIndex >= 0 && containerTypes[containerIndex] === 1) {
      arrayHasEntry[containerIndex] = 0
    } else if (byte === 0x3A && containerIndex >= 0 && containerTypes[containerIndex] === 2) {
      addEntry()
    }
  }

  return collectionEntries

  function markArrayEntry () {
    const index = depth - 1
    if (index < 0 || containerTypes[index] !== 1 || arrayHasEntry[index] !== 0) return
    arrayHasEntry[index] = 1
    addEntry()
  }

  function addEntry () {
    collectionEntries++
    if (collectionEntries > limits.maxCollectionEntries) {
      throw new Error(`${limits.label} exceeds ${limits.maxCollectionEntries} aggregate collection entries.`)
    }
  }
}

function isJsonWhitespace (byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D
}

module.exports = {
  DEFAULT_MAX_COLLECTION_ENTRIES,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAX_STRING_BYTES,
  parseBoundedJson,
}
