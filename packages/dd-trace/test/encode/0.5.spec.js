'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')

require('../setup/core')

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
      duration: 4564564564564564,
      links: []
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
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
    expect(trace[0][6]).to.equal(BigInt(data[0].start))
    expect(trace[0][7]).to.equal(BigInt(data[0].duration))
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({ [stringMap.indexOf('bar')]: stringMap.indexOf('baz') })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal('') // unset
  })

  it('should encode span events', () => {
    const topLevelEvents = [
      { name: 'Something went so wrong', time_unix_nano: 1000000 },
      {
        name: 'I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx',
        time_unix_nano: 1633023102000000,
        attributes: { emotion: 'happy', rating: 9.8, other: [1, 9.5, 1], idol: false }
      }
    ]

    const encodedLink = '[{"name":"Something went so wrong","time_unix_nano":1000000},' +
    '{"name":"I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx","time_unix_nano":1633023102000000,' +
    '"attributes":{"emotion":"happy","rating":9.8,"other":[1,9.5,1],"idol":false}}]'

    data[0].span_events = topLevelEvents

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const stringMap = decoded[0]
    const trace = decoded[1][0]
    expect(stringMap).to.include('events')
    expect(stringMap).to.include(encodedLink)
    expect(trace[0][9]).to.include({
      [stringMap.indexOf('bar')]: stringMap.indexOf('baz'),
      [stringMap.indexOf('events')]: stringMap.indexOf(encodedLink)
    })
  })

  it('should encode span links', () => {
    const traceIdHigh = id('10')
    const traceId = id('1234abcd1234abcd')
    const rootTid = traceIdHigh.toString(16).padStart(16, '0')
    const rootT64 = traceId.toString(16).padStart(16, '0')
    const traceIdVal = `${rootTid}${rootT64}`

    const encodedLink = `[{"trace_id":"${traceIdVal}","span_id":"1234abcd1234abcd",` +
    '"attributes":{"foo":"bar"},"tracestate":"dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar","flags":1}]'

    data[0].meta['_dd.span_links'] = encodedLink

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const stringMap = decoded[0]
    const trace = decoded[1][0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Array)
    expect(stringMap[trace[0][0]]).to.equal(data[0].service)
    expect(stringMap[trace[0][1]]).to.equal(data[0].name)
    expect(stringMap[trace[0][2]]).to.equal(data[0].resource)
    expect(stringMap).to.include('_dd.span_links')
    expect(stringMap).to.include(encodedLink)
    expect(trace[0][3].toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0][4].toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0][5].toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0][6]).to.equal(BigInt(data[0].start))
    expect(trace[0][7]).to.equal(BigInt(data[0].duration))
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({
      [stringMap.indexOf('bar')]: stringMap.indexOf('baz'),
      [stringMap.indexOf('_dd.span_links')]: stringMap.indexOf(encodedLink)
    })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal('') // unset
  })

  it('should encode span link with just span and trace id', () => {
    const traceId = '00000000000000001234abcd1234abcd'
    const spanId = '1234abcd1234abcd'
    const encodedLink = `[{"trace_id":"${traceId}","span_id":"${spanId}"}]`
    data[0].meta['_dd.span_links'] = encodedLink

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const stringMap = decoded[0]
    const trace = decoded[1][0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Array)
    expect(stringMap[trace[0][0]]).to.equal(data[0].service)
    expect(stringMap[trace[0][1]]).to.equal(data[0].name)
    expect(stringMap[trace[0][2]]).to.equal(data[0].resource)
    expect(stringMap).to.include('_dd.span_links')
    expect(stringMap).to.include(encodedLink)
    expect(trace[0][3].toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0][4].toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0][5].toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0][6]).to.equal(BigInt(data[0].start))
    expect(trace[0][7]).to.equal(BigInt(data[0].duration))
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({
      [stringMap.indexOf('bar')]: stringMap.indexOf('baz'),
      [stringMap.indexOf('_dd.span_links')]: stringMap.indexOf(encodedLink)
    })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal('') // unset
  })

  it('should truncate long IDs', () => {
    data[0].trace_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].span_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].arent_id = id('ffffffffffffffff1234abcd1234abcd')

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[1][0]

    expect(trace[0][3].toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0][4].toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0][5].toString(16)).to.equal('1234abcd1234abcd')
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

  it('should ignore meta_struct property', () => {
    data[0].meta_struct = { foo: 'bar' }

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
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
    expect(trace[0][6]).to.equal(BigInt(data[0].start))
    expect(trace[0][7]).to.equal(BigInt(data[0].duration))
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({ [stringMap.indexOf('bar')]: stringMap.indexOf('baz') })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal('') // unset
    expect(trace[0][12]).to.be.undefined // Everything works the same as without meta_struct, and nothing else is added
  })
})
