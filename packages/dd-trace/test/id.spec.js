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

  describe('reseed()', () => {
    let freshId
    let randomFillSyncStub
    let openSyncStub
    let readSyncStub
    let closeSyncStub

    beforeEach(() => {
      randomFillSyncStub = sinon.stub().callsFake(buf => {
        for (let i = 0; i < buf.length; i++) {
          buf[i] = 0xAB
        }
      })
      openSyncStub = sinon.stub().returns(7)
      readSyncStub = sinon.stub().callsFake((fd, buf, offset, len) => {
        for (let i = 0; i < len; i++) {
          buf[offset + i] = 0xCD
        }
        return len
      })
      closeSyncStub = sinon.stub()

      freshId = proxyquire('../src/id', {
        crypto: { randomFillSync: randomFillSyncStub },
        fs: { openSync: openSyncStub, readSync: readSyncStub, closeSync: closeSyncStub },
      })
    })

    it('should open /dev/urandom once on first call', () => {
      freshId.reseed()

      sinon.assert.calledOnce(openSyncStub)
      sinon.assert.calledWithExactly(openSyncStub, '/dev/urandom', 'r')
    })

    it('should switch pseudoRandom to use kernel (readSync called, randomFillSync not called after reset)', () => {
      freshId.reseed()
      randomFillSyncStub.resetHistory()

      // Force a batch refill by calling id() which calls pseudoRandom
      // batch starts at 0 after reseed, so first call triggers fill
      freshId()

      sinon.assert.called(readSyncStub)
      sinon.assert.notCalled(randomFillSyncStub)
    })

    it('should reset batch to 0 so next pseudoRandom triggers kernel fill', () => {
      // Call id() several times to advance the batch counter
      freshId()
      freshId()
      freshId()
      readSyncStub.resetHistory()

      freshId.reseed()
      // After reseed, batch = 0, so next call must refill
      freshId()

      sinon.assert.called(readSyncStub)
    })

    it('should be idempotent — second call does not reopen fd', () => {
      freshId.reseed()
      freshId.reseed()

      sinon.assert.calledOnce(openSyncStub)
    })

    it('should fall back to randomFillSync when openSync throws and not call readSync', () => {
      openSyncStub.throws(new Error('no /dev/urandom'))

      freshId.reseed()

      // After failed open, fill falls back to randomFillSync
      freshId()

      sinon.assert.notCalled(readSyncStub)
      sinon.assert.called(randomFillSyncStub)
    })
  })

  describe('kernelUUID()', () => {
    let freshId
    let randomFillSyncStub
    let openSyncStub
    let readSyncStub
    let closeSyncStub

    beforeEach(() => {
      let counter = 0
      randomFillSyncStub = sinon.stub().callsFake(buf => {
        for (let i = 0; i < buf.length; i++) {
          buf[i] = (counter++ * 37 + 17) & 0xFF
        }
      })
      openSyncStub = sinon.stub().returns(7)
      readSyncStub = sinon.stub().callsFake((fd, buf, offset, len) => {
        for (let i = 0; i < len; i++) {
          buf[offset + i] = (counter++ * 53 + 7) & 0xFF
        }
        return len
      })
      closeSyncStub = sinon.stub()

      freshId = proxyquire('../src/id', {
        crypto: { randomFillSync: randomFillSyncStub },
        fs: { openSync: openSyncStub, readSync: readSyncStub, closeSync: closeSyncStub },
      })
    })

    it('should return a valid RFC 4122 v4 UUID', () => {
      const result = freshId.kernelUUID()

      assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('should set version digit to 4 (UUID[14])', () => {
      const result = freshId.kernelUUID()

      assert.strictEqual(result[14], '4')
    })

    it('should set variant to 8/9/a/b (UUID[19])', () => {
      const result = freshId.kernelUUID()

      assert.match(result[19], /[89ab]/)
    })

    it('should generate unique UUIDs across 10 calls', () => {
      const uuids = new Set()
      for (let i = 0; i < 10; i++) {
        uuids.add(freshId.kernelUUID())
      }

      assert.strictEqual(uuids.size, 10)
    })

    it('should read from kernel (readSync) after reseed, not randomFillSync', () => {
      freshId.reseed()
      randomFillSyncStub.resetHistory()
      readSyncStub.resetHistory()

      freshId.kernelUUID()

      sinon.assert.called(readSyncStub)
      sinon.assert.notCalled(randomFillSyncStub)
    })

    it('should fall back to randomFillSync when fd unavailable (openSync throws + reseed called)', () => {
      openSyncStub.throws(new Error('no /dev/urandom'))
      freshId.reseed()
      randomFillSyncStub.resetHistory()
      readSyncStub.resetHistory()

      freshId.kernelUUID()

      sinon.assert.called(randomFillSyncStub)
      sinon.assert.notCalled(readSyncStub)
    })
  })
})
