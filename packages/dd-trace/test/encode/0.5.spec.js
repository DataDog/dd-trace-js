'use strict'

require('../setup/tap')

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../../src/id')

function randString (length) {
  return Array.from({ length }, () => {
    return String.fromCharCode(Math.floor(Math.random() * 256))
  }).join('')
}

describe('encode 0.5', () => {
  let encoder
  let writer
  let data

  beforeEach(() => {
    const { AgentEncoder } = require('../../src/encode/0.5')
    writer = { flush: sinon.spy() }
    encoder = new AgentEncoder(writer)
    data = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {
        example: 1
      },
      start: 123123123123123120,
      duration: 456456456456456456
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { codec })
    const stringMap = decoded[0]
    const trace = decoded[1][0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Array)
    expect(stringMap[trace[0][0]]).to.equal(data[0].service)
    expect(stringMap[trace[0][1]]).to.equal(data[0].name)
    expect(stringMap[trace[0][2]]).to.equal(data[0].resource)
    expect(trace[0][3].toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0][4].toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0][5].toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0][6].toNumber()).to.equal(data[0].start)
    expect(trace[0][7].toNumber()).to.equal(data[0].duration)
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({ [stringMap.indexOf('bar')]: stringMap.indexOf('baz') })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal('') // unset
  })

  it('should truncate long IDs', () => {
    data[0].trace_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].span_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].arent_id = id('ffffffffffffffff1234abcd1234abcd')

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { codec })
    const trace = decoded[1][0]

    expect(trace[0][3].toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0][4].toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0][5].toString(16)).to.equal('1234abcd1234abcd')
  })

  it('should truncate long fields', function () {
    const flushSize = 8 * 1024 * 1024
    const tooLongString = randString(flushSize)

    data[0].service = tooLongString
    data[0].name = tooLongString
    data[0].type = tooLongString
    data[0].resource = tooLongString
    data[0].meta.foo = tooLongString
    data[0].metrics.foo = tooLongString

    encoder.encode(data)

    expect(writer.flush).to.not.have.been.called
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(data)

    expect(encoder.count()).to.equal(1)

    encoder.encode(data)

    expect(encoder.count()).to.equal(2)
  })

  it('should flush when the payload size limit is reached', function () {
    // Make 8mb of data
    for (let i = 0; i < 8 * 1024; i++) {
      data[0].meta[`foo${i}`] = randString(1024)
    }

    encoder.encode(data)

    expect(writer.flush).to.have.been.called
  })

  it('should reset after making a payload', () => {
    encoder.encode(data)
    encoder.makePayload()

    const payload = encoder.makePayload()

    expect(encoder.count()).to.equal(0)
    expect(payload).to.have.length(12)
    expect(payload[5]).to.equal(1)
    expect(payload[11]).to.equal(0)
  })
})
