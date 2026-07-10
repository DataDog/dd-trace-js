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

    assert.throws(() => decodeMsgpack(nested), /nesting exceeds/)
    assert.throws(() => decodeMsgpack(oversizedCollection), /collection length/)
  })
})
