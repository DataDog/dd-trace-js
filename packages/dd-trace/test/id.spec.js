'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('id', () => {
  let id
  let crypto

  beforeEach(() => {
    crypto = {
      randomFillSync: data => {
        for (let i = 0; i < data.length; i += 8) {
          data[i] = 0xFF
          data[i + 1] = 0x00
          data[i + 2] = 0xFF
          data[i + 3] = 0x00
          data[i + 4] = 0xFF
          data[i + 5] = 0x00
          data[i + 6] = 0xFF
          data[i + 7] = 0x00
        }
      },
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      crypto,
    })
  })

  afterEach(() => {
    Math.random.restore()
  })

  it('should return a random 63bit ID', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    assert.strictEqual(id().toString(), '7f00ff00ff00ff00')
  })

  it('should be serializable to an integer', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const spanId = id()

    assert.strictEqual(spanId.toString(10), '9151594822560186112')
  })

  it('should be serializable to JSON', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    assert.strictEqual(json, '"7f00ff00ff00ff00"')
  })

  it('should support small hex strings', () => {
    const spanId = id('abcd', 16)

    assert.strictEqual(spanId.toString(), '000000000000abcd')
  })

  it('should support large hex strings', () => {
    const spanId = id('12293a8527e70a7f27c8d624ace0f559', 16)

    assert.strictEqual(spanId.toString(), '12293a8527e70a7f27c8d624ace0f559')
    assert.strictEqual(spanId.toString(10), '2866776615828911449')
  })

  it('should use hex strings by default', () => {
    const spanId = id('abcd')

    assert.strictEqual(spanId.toString(), '000000000000abcd')
  })

  it('should support number strings', () => {
    const spanId = id('1234', 10)

    assert.strictEqual(spanId.toString(10), '1234')
  })

  it('should return the ID as BigInt', () => {
    const ids = [
      ['13835058055282163712', 13835058055282163712n],
      ['10', 10n],
      ['9007199254740991', 9007199254740991n],
    ]

    for (const [tid, expected] of ids) {
      const spanId = id(tid, 10)

      assert.strictEqual(spanId.toBigInt(), expected)
    }
  })

  it('should return the same BigInt value across repeated toBigInt calls', () => {
    const samples = [
      id('abcd', 16),
      id('12293a8527e70a7f27c8d624ace0f559', 16),
      id('1234', 10),
      id('0', 16),
    ]

    for (const spanId of samples) {
      const first = spanId.toBigInt()
      assert.strictEqual(spanId.toBigInt(), first)
      assert.strictEqual(spanId.toBigInt(), first)
    }
  })

  it('should match Buffer#readBigUInt64BE on the underlying buffer', () => {
    const cases = ['abcd', '12293a8527e70a7f27c8d624ace0f559', '7f00ff00ff00ff00']

    for (const hex of cases) {
      const spanId = id(hex, 16)
      const expected = Buffer.from(spanId.toBuffer()).readBigUInt64BE(0)

      assert.strictEqual(spanId.toBigInt(), expected)
    }
  })

  it('should return the same string across repeated toString calls for radix 16 and radix 10', () => {
    const samples = [
      id('abcd', 16),
      id('12293a8527e70a7f27c8d624ace0f559', 16),
      id('1234', 10),
      id('0', 16),
    ]

    for (const spanId of samples) {
      const hex = spanId.toString(16)
      assert.strictEqual(spanId.toString(16), hex)
      assert.strictEqual(spanId.toString(), hex)
      assert.strictEqual(spanId.toJSON(), hex)

      const decimal = spanId.toString(10)
      assert.strictEqual(spanId.toString(10), decimal)
    }
  })

  it('should still recompute toString for other radices and not pollute the hex/decimal caches', () => {
    const spanId = id('abcd', 16)

    assert.strictEqual(spanId.toString(8), '125715')
    assert.strictEqual(spanId.toString(8), '125715')
    assert.strictEqual(spanId.toString(2), '1010101111001101')

    assert.strictEqual(spanId.toString(16), '000000000000abcd')
    assert.strictEqual(spanId.toString(10), '43981')
  })
})

describe('AWS_LAMBDA_MICROVM_IMAGE_ARN activation', () => {
  const microVmArn = 'arn:aws:lambda:us-east-2:123456789012:microvm:my-app'

  function loadWithMock (arn) {
    let secureCalls = 0
    let batchCalls = 0
    const mockCrypto = {
      randomFillSync (buf) {
        if (buf.length === 8) {
          secureCalls++
        } else {
          batchCalls++
        }
        for (let i = 0; i < buf.length; i++) buf[i] = 0xAB
      },
    }
    if (arn !== undefined) {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = arn
    } else {
      delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    }
    const mod = proxyquire('../src/id', { crypto: mockCrypto })
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    return { mod, secureCalls: () => secureCalls, batchCalls: () => batchCalls }
  }

  it('should use per-call randomFillSync when AWS_LAMBDA_MICROVM_IMAGE_ARN is set', () => {
    const { mod, secureCalls } = loadWithMock(microVmArn)
    mod()
    assert.ok(secureCalls() > 0, 'expected 8-byte randomFillSync call when ARN is set')
  })

  it('should use batch randomFillSync when AWS_LAMBDA_MICROVM_IMAGE_ARN is unset', () => {
    const { mod, batchCalls } = loadWithMock(undefined)
    mod()
    assert.ok(batchCalls() > 0, 'expected batch randomFillSync call when ARN is unset')
  })

  it('should use batch randomFillSync when AWS_LAMBDA_MICROVM_IMAGE_ARN is empty string', () => {
    const { mod, batchCalls } = loadWithMock('')
    mod()
    assert.ok(batchCalls() > 0, 'expected batch randomFillSync call when ARN is empty')
  })
})

describe('id in Lambda MicroVM environment', () => {
  let id

  beforeEach(() => {
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = 'arn:aws:lambda:us-east-2:123456789012:microvm:my-app'
    delete require.cache[require.resolve('../src/id')]
    id = require('../src/id')
  })

  afterEach(() => {
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    delete require.cache[require.resolve('../src/id')]
  })

  it('should generate non-zero IDs', () => {
    for (let i = 0; i < 10; i++) {
      const spanId = id()
      assert.notStrictEqual(spanId.toString(), '0000000000000000')
    }
  })

  it('should generate varied IDs', () => {
    const seen = new Set()
    for (let i = 0; i < 100; i++) {
      seen.add(id().toString())
    }
    assert.ok(seen.size > 90, `expected >90 unique IDs, got ${seen.size}`)
  })

  it('should generate IDs with the high bit of the first byte clear', () => {
    for (let i = 0; i < 100; i++) {
      const spanId = id()
      const hex = spanId.toString()
      const firstByte = Number.parseInt(hex.slice(0, 2), 16)
      assert.strictEqual(firstByte & 0x80, 0, `expected high bit clear, got 0x${firstByte.toString(16)}`)
    }
  })

  it('should generate IDs with hex length of 16 characters', () => {
    for (let i = 0; i < 10; i++) {
      const spanId = id()
      assert.strictEqual(spanId.toString().length, 16)
    }
  })
})
