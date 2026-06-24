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

  function loadWithMock (arn, {
    openThrows = false,
    chunk = Infinity,
    readThrows = false,
    readReturnsZero = false,
  } = {}) {
    let opens = 0
    let kernelReads = 0
    let perCallFill = 0
    let batchFill = 0
    const mockFs = {
      openSync () {
        opens++
        if (openThrows) throw new Error('ENOENT: no /dev/urandom')
        return 42
      },
      readSync (fd, buf, offset, length) {
        kernelReads++
        if (readThrows) throw new Error('EIO: kernel read failed')
        if (readReturnsZero) return 0
        const n = Math.min(length, chunk)
        for (let i = offset; i < offset + n; i++) buf[i] = 0xAB
        return n
      },
    }
    const mockCrypto = {
      randomFillSync (buf) {
        if (buf.length === 8) {
          perCallFill++
        } else {
          batchFill++
        }
        for (let i = 0; i < buf.length; i++) buf[i] = 0xAB
      },
    }
    const previousArn = process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    if (arn !== undefined) {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = arn
    } else {
      delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    }
    const mod = proxyquire('../src/id', { crypto: mockCrypto, fs: mockFs })
    if (previousArn === undefined) {
      delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    } else {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = previousArn
    }
    return {
      mod,
      opens: () => opens,
      kernelReads: () => kernelReads,
      perCallFill: () => perCallFill,
      batchFill: () => batchFill,
    }
  }

  it('draws each id from the kernel CSPRNG when AWS_LAMBDA_MICROVM_IMAGE_ARN is set', () => {
    const { mod, kernelReads, batchFill } = loadWithMock(microVmArn)
    mod()
    assert.ok(kernelReads() > 0, 'expected a /dev/urandom read per id when ARN is set')
    assert.strictEqual(batchFill(), 0, 'must not fill the batch buffer in MicroVM mode')
  })

  it('uses the batch buffer when AWS_LAMBDA_MICROVM_IMAGE_ARN is unset', () => {
    const { mod, batchFill, kernelReads } = loadWithMock(undefined)
    mod()
    assert.ok(batchFill() > 0, 'expected a batch randomFillSync when ARN is unset')
    assert.strictEqual(kernelReads(), 0, 'must not read /dev/urandom outside a MicroVM')
  })

  it('uses the batch buffer when AWS_LAMBDA_MICROVM_IMAGE_ARN is empty string', () => {
    const { mod, batchFill } = loadWithMock('')
    mod()
    assert.ok(batchFill() > 0, 'expected a batch randomFillSync when ARN is empty')
  })

  it('falls back to per-call randomFillSync when /dev/urandom cannot be opened', () => {
    const { mod, perCallFill, kernelReads } = loadWithMock(microVmArn, { openThrows: true })
    mod()
    assert.ok(perCallFill() > 0, 'expected per-call randomFillSync fallback')
    assert.strictEqual(kernelReads(), 0, 'no kernel reads when the fd could not be opened')
  })

  it('opens /dev/urandom once and reads it once per id', () => {
    const { mod, opens, kernelReads } = loadWithMock(microVmArn)
    mod()
    mod()
    mod()
    assert.strictEqual(opens(), 1, 'fd opened once at module load, not per id')
    assert.strictEqual(kernelReads(), 3, 'one kernel read per id')
  })

  it('accumulates short /dev/urandom reads until the 8-byte buffer is full', () => {
    const { mod, kernelReads } = loadWithMock(microVmArn, { chunk: 3 })
    const spanId = mod()
    assert.ok(kernelReads() > 1, `expected multiple short reads, got ${kernelReads()}`)
    // mock fills every byte with 0xAB; the first byte has its MSB cleared
    // (0xAB & 0x7F = 0x2B), so a fully-filled buffer is 2b then seven ab bytes.
    assert.strictEqual(spanId.toString(), '2bababababababab')
  })

  it('falls back to randomFillSync if a kernel read returns 0 (no infinite loop)', () => {
    const { mod, perCallFill } = loadWithMock(microVmArn, { readReturnsZero: true })
    mod()
    assert.ok(perCallFill() > 0, 'expected randomFillSync fallback when a read returns 0')
  })

  it('falls back and stops using the fd when a kernel read throws', () => {
    const { mod, perCallFill, kernelReads } = loadWithMock(microVmArn, { readThrows: true })
    mod()
    const readsAfterFirst = kernelReads()
    mod()
    assert.ok(perCallFill() >= 2, 'both ids fall back to randomFillSync')
    assert.strictEqual(kernelReads(), readsAfterFirst, 'fd disabled after the throw; no more kernel reads')
  })
})

describe('id in Lambda MicroVM environment', () => {
  let id
  let previousArn

  beforeEach(() => {
    previousArn = process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = 'arn:aws:lambda:us-east-2:123456789012:microvm:my-app'
    delete require.cache[require.resolve('../src/id')]
    id = require('../src/id')
  })

  afterEach(() => {
    if (previousArn === undefined) {
      delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
    } else {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = previousArn
    }
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
