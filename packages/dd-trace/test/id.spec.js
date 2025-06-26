'use strict'

const t = require('tap')
require('./setup/core')

t.test('id', t => {
  let id
  let crypto

  t.beforeEach(() => {
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
      }
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      crypto
    })
  })

  t.afterEach(() => {
    Math.random.restore()
  })

  t.test('should return a random 63bit ID', t => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    expect(id().toString()).to.equal('7f00ff00ff00ff00')
    t.end()
  })

  t.test('should be serializable to an integer', t => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const spanId = id()

    expect(spanId.toString(10)).to.equal('9151594822560186112')
    t.end()
  })

  t.test('should be serializable to JSON', t => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    expect(json).to.equal('"7f00ff00ff00ff00"')
    t.end()
  })

  t.test('should support small hex strings', t => {
    const spanId = id('abcd', 16)

    expect(spanId.toString()).to.equal('000000000000abcd')
    t.end()
  })

  t.test('should support large hex strings', t => {
    const spanId = id('12293a8527e70a7f27c8d624ace0f559', 16)

    expect(spanId.toString()).to.equal('12293a8527e70a7f27c8d624ace0f559')
    expect(spanId.toString(10)).to.equal('2866776615828911449')
    t.end()
  })

  t.test('should use hex strings by default', t => {
    const spanId = id('abcd')

    expect(spanId.toString()).to.equal('000000000000abcd')
    t.end()
  })

  t.test('should support number strings', t => {
    const spanId = id('1234', 10)

    expect(spanId.toString(10)).to.equal('1234')
    t.end()
  })

  t.test('should return the ID as BigInt', t => {
    const ids = [
      ['13835058055282163712', 13835058055282163712n],
      ['10', 10n],
      ['9007199254740991', 9007199254740991n]
    ]

    for (const [tid, expected] of ids) {
      const spanId = id(tid, 10)

      expect(spanId.toBigInt()).to.equal(expected)
    }
    t.end()
  })
  t.end()
})
