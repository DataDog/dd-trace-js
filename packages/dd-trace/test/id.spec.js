'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('id', () => {
  let id
  let crypto
  let fs

  beforeEach(() => {
    crypto = {
      randomFillSync: sinon.stub().callsFake(data => {
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
      }),
    }

    fs = {
      openSync: sinon.stub().returns(42),
      readSync: sinon.stub().callsFake((fd, buf, offset, len) => {
        for (let i = 0; i < len; i++) buf[offset + i] = 0xAB
        return len
      }),
      closeSync: sinon.stub(),
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      crypto,
    })
  })

  afterEach(() => {
    Math.random.restore()
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN
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

  describe('MicroVM', () => {
    // Each test loads a fresh module with AWS_LAMBDA_MICROVM_IMAGE_ARN set so
    // isMicroVm, batchReseeded, and urandomFd are all re-initialised.
    const loadMicroVmId = () => {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN = 'arn:aws:lambda:us-east-1:123:microvm-image/img:1'
      return proxyquire('../src/id', { crypto, fs })
    }

    describe('init window (before reseedBatchBuffer)', () => {
      it('should draw each ID from the kernel CSPRNG via readSync', () => {
        const microId = loadMicroVmId()

        microId()
        microId()

        // readSync called twice (8 bytes each) — once per ID
        sinon.assert.calledTwice(fs.readSync)
        sinon.assert.notCalled(crypto.randomFillSync)
      })

      it('should produce IDs sourced from the kernel buffer (0xAB pattern)', () => {
        const microId = loadMicroVmId()

        // readSync fills each byte with 0xAB; high bit is masked to 0x7F → 0x2B
        assert.strictEqual(microId().toString(), '2bababababababab')
      })

      it('should not share state between calls (no batch cursor advance)', () => {
        const microId = loadMicroVmId()

        const first = microId().toString()
        const second = microId().toString()

        // Both IDs come from fillFromKernel, not from advancing a shared batch offset
        assert.strictEqual(first, second) // same fill pattern from our deterministic stub
        sinon.assert.calledTwice(fs.readSync)
      })
    })

    describe('reseedBatchBuffer', () => {
      it('should switch subsequent IDs to the fast batch path', () => {
        const microId = loadMicroVmId()

        microId.reseedBatchBuffer()

        microId()
        microId()

        // After reseed, IDs come from randomFillSync (batch), not readSync
        sinon.assert.called(crypto.randomFillSync)
        sinon.assert.notCalled(fs.readSync)
      })

      it('should produce IDs from randomFillSync (0xFF pattern) after reseed', () => {
        const microId = loadMicroVmId()

        microId.reseedBatchBuffer()
        const result = microId().toString()

        // batch === 0 triggers randomFillSync (0xFF/0x00 pattern); high bit masked → 0x7F
        assert.strictEqual(result, '7f00ff00ff00ff00')
      })

      it('should reset the batch cursor to 0 so the first post-reseed call refills lazily', () => {
        const microId = loadMicroVmId()

        microId.reseedBatchBuffer()

        // reseedBatchBuffer itself does NOT call randomFillSync (lazy fill)
        sinon.assert.notCalled(crypto.randomFillSync)

        microId() // batch === 0 → fills now, then advances to 1
        assert.strictEqual(crypto.randomFillSync.callCount, 1)

        microId() // batch === 1 → no refill
        assert.strictEqual(crypto.randomFillSync.callCount, 1)
      })
    })

    describe('fillFromKernel fallback', () => {
      it('should loop on short reads until the buffer is filled', () => {
        let callCount = 0
        fs.readSync = sinon.stub().callsFake((fd, buf, offset, len) => {
          // Return 4 bytes on odd calls, 4 on even calls → 2 calls to fill 8 bytes
          callCount++
          const half = Math.ceil(len / 2)
          for (let i = 0; i < half; i++) buf[offset + i] = 0xAB
          return half
        })

        const microId = loadMicroVmId()
        microId()

        assert.ok(fs.readSync.callCount >= 2, 'should call readSync more than once for short reads')
        sinon.assert.notCalled(crypto.randomFillSync)
      })

      it('should fall back to randomFillSync when readSync returns 0', () => {
        fs.readSync = sinon.stub().returns(0)

        const microId = loadMicroVmId()
        microId()

        sinon.assert.called(crypto.randomFillSync)
      })

      it('should close the fd and fall back to randomFillSync when readSync throws', () => {
        fs.readSync = sinon.stub().throws(new Error('EIO'))

        const microId = loadMicroVmId()
        microId()

        sinon.assert.calledOnce(fs.closeSync)
        sinon.assert.called(crypto.randomFillSync)
      })

      it('should not retry a broken fd on subsequent calls', () => {
        fs.readSync = sinon.stub().throws(new Error('EIO'))

        const microId = loadMicroVmId()
        microId() // first call: fd fails, falls back, closes fd
        microId() // second call: fd is -1, goes straight to randomFillSync

        sinon.assert.calledOnce(fs.closeSync)
        assert.strictEqual(fs.readSync.callCount, 1)
      })

      it('should use randomFillSync directly when openSync fails', () => {
        fs.openSync = sinon.stub().throws(new Error('ENOENT'))

        const microId = loadMicroVmId()
        microId()

        sinon.assert.called(crypto.randomFillSync)
        sinon.assert.notCalled(fs.readSync)
      })
    })
  })
})
