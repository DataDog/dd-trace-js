'use strict'

describe('id', () => {
  let id
  let crypto

  beforeEach(() => {
    const seeds = new Uint32Array(2)

    seeds[0] = seeds[1] = 0xFF000000

    crypto = {
      randomBytes: sinon.stub().returns(Buffer.from(seeds.buffer))
    }

    sinon.stub(Math, 'random')

    id = proxyquire('../src/id', {
      'crypto': crypto
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

    const spanId = id()

    expect(spanId.toString(10)).to.equal('9151594822560186112')
  })

  it('should be serializable to JSON', () => {
    Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

    const json = JSON.stringify(id())

    expect(json).to.equal('"7f00ff00ff00ff00"')
  })

  it('should support hex strings', () => {
    const spanId = id('abcd')

    expect(spanId.toString()).to.equal('abcd')
  })

  it('should support number strings', () => {
    const spanId = id('1234', 10)

    expect(spanId.toString(10)).to.equal('1234')
  })
})
