'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec()

const {
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('../../src/encode/tags-processors')

describe('span-stats-encode', () => {
  let encoder
  let writer
  let logger
  let stats
  let bucket
  let stat

  beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { SpanStatsEncoder } = proxyquire('../src/encode/span-stats', {
      '../log': logger
    })
    writer = { flush: sinon.spy() }
    encoder = new SpanStatsEncoder(writer)

    stat = {
      Name: 'web.request',
      Type: 'web',
      Service: 'dd-trace',
      Resource: 'GET',
      Synthetics: false,
      HTTPStatusCode: 200,
      Hits: 30799,
      TopLevelHits: 30799,
      Duration: 1230,
      Errors: 0,
      OkSummary: Buffer.from(''),
      ErrorSummary: Buffer.from('')
    }

    bucket = {
      Start: 1660000000000,
      Duration: 10000000000,
      Stats: [
        stat
      ]
    }

    stats = {
      Hostname: 'COMP-C02F806TML87',
      Env: 'env',
      Version: '4.0.0-pre',
      Stats: [
        bucket
      ],
      Lang: 'javascript',
      TracerVersion: '1.2.3',
      RuntimeID: 'some-runtime-id',
      Sequence: 1
    }
  })

  it('should encode to msgpack', () => {
    encoder.encode(stats)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.deep.equal(stats)
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(stats)

    expect(encoder.count()).to.equal(1)

    encoder.encode(stats)

    expect(encoder.count()).to.equal(2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(stats)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
  })

  it('should truncate name, service, type and resource when they are too long', () => {
    const tooLongString = new Array(500).fill('a').join('')
    const resourceTooLongString = new Array(10000).fill('a').join('')
    const statsToTruncate = {
      ...stats,
      Stats: [
        {
          ...bucket,
          Stats: [
            {
              ...stat,
              Name: tooLongString,
              Type: tooLongString,
              Service: tooLongString,
              Resource: resourceTooLongString
            }
          ]
        }
      ]
    }
    encoder.encode(statsToTruncate)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded)
    const decodedStat = decoded.Stats[0].Stats[0]
    expect(decodedStat.Type.length).to.equal(MAX_TYPE_LENGTH)
    expect(decodedStat.Name.length).to.equal(MAX_NAME_LENGTH)
    expect(decodedStat.Service.length).to.equal(MAX_SERVICE_LENGTH)
    // ellipsis is added
    expect(decodedStat.Resource.length).to.equal(MAX_RESOURCE_NAME_LENGTH + 3)
  })

  it('should fallback to a default name and service if they are not present', () => {
    const statsToTruncate = {
      ...stats,
      Stats: [
        {
          ...bucket,
          Stats: [
            {
              ...stat,
              Name: undefined,
              Service: undefined
            }
          ]
        }
      ]
    }
    encoder.encode(statsToTruncate)

    const buffer = encoder.makePayload()
    const decodedStats = msgpack.decode(buffer, { codec })
    expect(decodedStats)

    const decodedStat = decodedStats.Stats[0].Stats[0]
    expect(decodedStat)
    expect(decodedStat.Service).to.equal(DEFAULT_SERVICE_NAME)
    expect(decodedStat.Name).to.equal(DEFAULT_SPAN_NAME)
  })
})
