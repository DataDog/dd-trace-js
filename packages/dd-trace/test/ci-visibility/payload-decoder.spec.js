'use strict'

const assert = require('node:assert/strict')
const zlib = require('node:zlib')

const {
  decodeBody,
  decodeMsgpack,
} = require('../../../../ci/test-optimization-validation/payload-decoder')

describe('test optimization validation payload decoder', () => {
  it('caps decompressed intake payloads', () => {
    const compressed = zlib.gzipSync(Buffer.alloc(1024 * 1024, 0x20))

    assert.throws(() => decodeBody(compressed, {
      'content-encoding': 'gzip',
      'content-type': 'text/plain',
    }, {
      maxOutputLength: 1024,
    }), /larger than|output length|Cannot create a Buffer larger than/i)
  })

  it('decodes MessagePack maps without mutating their prototype', () => {
    const payload = Buffer.concat([
      Buffer.from([0x81, 0xA9]),
      Buffer.from('__proto__'),
      Buffer.from([0x81, 0xA8]),
      Buffer.from('polluted'),
      Buffer.from([0xC3]),
    ])
    const decoded = decodeMsgpack(payload)

    assert.strictEqual(Object.getPrototypeOf(decoded), null)
    assert.strictEqual(Object.hasOwn(decoded, '__proto__'), true)
    assert.strictEqual(Reflect.get(decoded, '__proto__').polluted, true)
    assert.strictEqual({}.polluted, undefined)
  })

  it('rejects excessive MessagePack nesting and collection lengths', () => {
    const nested = Buffer.concat([
      Buffer.alloc(129, 0x91),
      Buffer.from([0xC0]),
    ])
    const oversizedCollection = Buffer.from([0xDD, 0xFF, 0xFF, 0xFF, 0xFF])
    const tooManyEntries = Buffer.alloc(5 + 100_001, 0xC0)
    tooManyEntries[0] = 0xDD
    tooManyEntries.writeUInt32BE(100_001, 1)

    assert.throws(() => decodeMsgpack(nested), /nesting exceeds/)
    assert.throws(() => decodeMsgpack(oversizedCollection), /collection length/)
    assert.throws(() => decodeMsgpack(tooManyEntries), /entry limit/)
  })

  it('caps MessagePack collection entries across the full decoded object graph', () => {
    const arrayHeader = Buffer.alloc(3)
    arrayHeader[0] = 0xDC
    arrayHeader.writeUInt16BE(500, 1)
    const innerArray = Buffer.concat([arrayHeader, Buffer.alloc(500, 0xC0)])
    const aggregate = Buffer.concat([arrayHeader, ...new Array(500).fill(innerArray)])

    assert.throws(() => decodeMsgpack(aggregate), /aggregate collection entries/)
  })

  it('accepts the last bounded MessagePack string and rejects the first oversized string', () => {
    const accepted = msgpackString(64 * 1024)
    const rejected = msgpackString(64 * 1024 + 1)

    assert.strictEqual(decodeMsgpack(accepted).length, 64 * 1024)
    assert.throws(() => decodeMsgpack(rejected), /MessagePack string exceeds/)
  })

  it('caps JSON collection entries across the full decoded object graph', () => {
    const aggregate = Buffer.from(JSON.stringify(new Array(100_001).fill(null)))
    const invalidAggregate = Buffer.from(`[${','.repeat(100_001)}`)

    assert.throws(() => decodeBody(aggregate, { 'content-type': 'application/json' }),
      /JSON aggregate collection entries/)
    assert.throws(() => decodeBody(invalidAggregate, { 'content-type': 'application/json' }),
      /JSON aggregate collection entries/)
    assert.throws(() => decodeBody(zlib.gzipSync(invalidAggregate), {
      'content-encoding': 'gzip',
      'content-type': 'application/json',
    }), /JSON aggregate collection entries/)
  })

  it('caps JSON nesting before parsing malformed input', () => {
    const accepted = Buffer.from(`${'['.repeat(128)}0${']'.repeat(128)}`)
    const rejected = Buffer.from(`${'['.repeat(129)}0${']'.repeat(129)}`)
    const malformed = Buffer.from('{'.repeat(129))

    decodeBody(accepted, { 'content-type': 'application/json' })
    assert.throws(() => decodeBody(rejected, { 'content-type': 'application/json' }), /JSON nesting exceeds/)
    assert.throws(() => decodeBody(malformed, { 'content-type': 'application/json' }), /JSON nesting exceeds/)
  })
})

function msgpackString (length) {
  const payload = Buffer.alloc(5 + length, 0x78)
  payload[0] = 0xDB
  payload.writeUInt32BE(length, 1)
  return payload
}
