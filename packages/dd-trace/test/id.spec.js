'use strict'

const Uint64BE = require('../src/uint64be')

wrapIt()

describe('id', () => {
  let id
  let platform

  beforeEach(() => {
    const seeds = new Uint32Array(2)

    seeds[0] = seeds[1] = 0xFF000000

    platform = {
      crypto: {
        getRandomValues (typedArray) {
          typedArray.set(seeds)
        }
      }
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      './platform': platform
    })
  })

  afterEach(() => {
    Math.random.restore()
  })

  it('should return a random 63bit ID', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    expect(id().toString()).to.equal('7f00ff00ff00ff00')
  })

  it('should be serializable to an integer', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    expect(id().toString(10)).to.equal('9151594822560186112')
  })

  it('should be serializable to JSON', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    expect(json).to.equal('"7f00ff00ff00ff00"')
  })

  it('should be exportable to Uint64BE', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const uint64 = id().toUint64BE()

    expect(uint64).to.be.instanceof(Uint64BE)
    expect(uint64.toString()).to.equal('9151594822560186112')
  })
})
