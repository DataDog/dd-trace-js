'use strict'

const { MAX_SIZE, OverflowError } = require('../msgpack')
const { normalizeSpan } = require('./tags-processors')
const { AgentEncoder: BaseEncoder, stringifySpanEvents } = require('./0.4')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9C

// Per-span fused head: `[0x9C, service-idx, name-idx, resource-idx,
// trace-id, span-id, parent-id]` — three uint32 indexes (5 bytes each) +
// three uint64 IDs (9 bytes each) + the array marker. Replaces seven
// separate reserves (`writeByte` + 3 × `writeInteger` + 3 × `_encodeId`)
// with one block-sized reserve per span.
const HEAD_BLOCK_SIZE = 1 + 5 * 3 + 9 * 3

function formatSpan (span) {
  span = normalizeSpan(span)
  // v0.5 has no native span_events slot; always serialize as a meta tag.
  if (span.span_events) {
    // TODO: this is a costly operation. Consolidate this with the formatter
    span.meta.events = stringifySpanEvents(span.span_events)
    // `= undefined` over `delete` to keep the span's hidden class.
    span.span_events = undefined
  }
  return span
}

class AgentEncoder extends BaseEncoder {
  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const traceSize = this._traceBytes.length + 5
    const payloadSize = prefixSize + stringSize + traceSize

    // The string table and the trace bytes are capped independently, so both
    // can sit just under the cap while their concatenation crosses it. `encode`
    // never sees this overflow — it only exists once the two are summed here —
    // so the writer's flush-time catch drops the payload.
    if (payloadSize > MAX_SIZE) {
      throw new OverflowError(payloadSize)
    }

    const buffer = Buffer.allocUnsafe(payloadSize)

    buffer[0] = ARRAY_OF_TWO

    const offset = this._writeStrings(buffer, 1)
    this._writeTraces(buffer, offset)

    this._reset()

    return buffer
  }

  _encode (bytes, trace) {
    bytes.writeArrayPrefix(trace)

    const stringMap = this._stringMap

    for (let span of trace) {
      span = formatSpan(span)

      // Resolve the three head string indices up front. `_cacheString`
      // writes into `_stringBytes`, an independent chunk, so the side
      // effect is safe to interleave with the `_traceBytes` reserve
      // below.
      const serviceIndex = stringMap[span.service] ?? this._cacheString(span.service)
      const nameIndex = stringMap[span.name] ?? this._cacheString(span.name)
      const resourceIndex = stringMap[span.resource] ?? this._cacheString(span.resource)

      const blockOffset = bytes.length
      bytes.reserve(HEAD_BLOCK_SIZE)
      const target = bytes.buffer

      target[blockOffset] = ARRAY_OF_TWELVE
      let cursor = this.#writeIndexAt(target, blockOffset + 1, serviceIndex)
      cursor = this.#writeIndexAt(target, cursor, nameIndex)
      cursor = this.#writeIndexAt(target, cursor, resourceIndex)
      cursor = this.#writeIdAt(target, cursor, span.trace_id)
      cursor = this.#writeIdAt(target, cursor, span.span_id)
      this.#writeIdAt(target, cursor, span.parent_id)

      bytes.writeIntOrFloat(span.start || 0)
      bytes.writeIntOrFloat(span.duration || 0)
      bytes.writeIntOrFloat(span.error)
      this._encodeMap(bytes, span.meta || {})
      this._encodeMap(bytes, span.metrics || {})
      this._encodeString(bytes, span.type)
    }
  }

  // Override the inherited 0.4 `_encodeMap` so the v0.5 wire emits each numeric
  // value via `_encodeIntOrFloat` (compact unsigned/signed int when integer,
  // float64 otherwise) instead of always float64. The 0.4 base method stays on
  // float64 because the CI-visibility encoders inherit it and target a
  // different intake.
  _encodeMap (bytes, value) {
    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDF

    const stringMap = this._stringMap
    let count = 0
    for (const key of Object.keys(value)) {
      const entryValue = value[key]
      if (typeof entryValue !== 'string' && typeof entryValue !== 'number') continue

      const keyIndex = stringMap[key] ?? this._cacheString(key)
      const writeOffset = bytes.length

      if (typeof entryValue === 'string') {
        // Both halves are uint32 indices on the v0.5 wire — known
        // size, so the key and value pair fuses into one reserve.
        const valueIndex = stringMap[entryValue] ?? this._cacheString(entryValue)
        bytes.reserve(10)
        const target = bytes.buffer
        this.#writeIndexAt(target, writeOffset, keyIndex)
        this.#writeIndexAt(target, writeOffset + 5, valueIndex)
      } else {
        // Speculate that the value is a positive fixint (0..127). The
        // metrics map is mostly small unsigned integers (sample priority,
        // `_dd.measured`, attribute counts), so one reserve covers the
        // key (5 bytes) and the value (1 byte). Misses rewind the
        // speculative value byte and route the value through the full
        // encoder so the wire still picks the shortest valid encoding.
        bytes.reserve(6)
        const target = bytes.buffer
        this.#writeIndexAt(target, writeOffset, keyIndex)
        if (entryValue === (entryValue & 0x7F)) {
          target[writeOffset + 5] = entryValue
        } else {
          bytes.length = writeOffset + 5
          bytes.writeIntOrFloat(entryValue)
        }
      }
      count++
    }

    const target = bytes.buffer
    target[offset + 1] = count >>> 24
    target[offset + 2] = count >>> 16
    target[offset + 3] = count >>> 8
    target[offset + 4] = count
  }

  _encodeString (bytes, value = '') {
    const index = this._stringMap[value] ?? this._cacheString(value)
    bytes.writeInteger(index)
  }

  _cacheString (value) {
    let index = this._stringMap[value]
    if (index === undefined) {
      index = this._stringCount++
      this._stringMap[value] = index
      this._stringBytes.write(value)
    }
    return index
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }

  /**
   * Write `[0xCE, uint32(index)]` into `target` at `offset` and return the
   * new cursor. Caller is responsible for having reserved enough room.
   *
   * @param {Uint8Array} target
   * @param {number} offset
   * @param {number} index
   * @returns {number}
   */
  #writeIndexAt (target, offset, index) {
    target[offset] = 0xCE
    target[offset + 1] = index >> 24
    target[offset + 2] = index >> 16
    target[offset + 3] = index >> 8
    target[offset + 4] = index
    return offset + 5
  }

  /**
   * Write `[0xCF, uint64(id)]` into `target` at `offset` and return the
   * new cursor. The id is truncated to the low 8 bytes, matching the
   * inherited `_encodeId` behavior.
   *
   * @param {Uint8Array} target
   * @param {number} offset
   * @param {{ toBuffer: () => Uint8Array | number[] }} identifier
   * @returns {number}
   */
  #writeIdAt (target, offset, identifier) {
    target[offset] = 0xCF
    const idBuffer = identifier.toBuffer()
    const start = idBuffer.length - 8
    target[offset + 1] = idBuffer[start]
    target[offset + 2] = idBuffer[start + 1]
    target[offset + 3] = idBuffer[start + 2]
    target[offset + 4] = idBuffer[start + 3]
    target[offset + 5] = idBuffer[start + 4]
    target[offset + 6] = idBuffer[start + 5]
    target[offset + 7] = idBuffer[start + 6]
    target[offset + 8] = idBuffer[start + 7]
    return offset + 9
  }
}

module.exports = { AgentEncoder }
