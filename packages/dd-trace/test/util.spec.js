'use strict'

const { isTrue, isFalse, globMatch, resolveHostDetails } = require('../src/util')

const TRUES = [
  1,
  true,
  'true',
  'TRUE',
  'tRuE'
]
const FALSES = [
  0,
  false,
  'false',
  'FALSE',
  'fAlSe'
]

const MATCH_CASES = [
  { pattern: 'foo', subject: 'foo' },
  { pattern: 'foo.*', subject: 'foo.you' },
  { pattern: 'hi*there', subject: 'hithere' },
  { pattern: '*stuff', subject: 'lots of stuff' },
  { pattern: 'test.?', subject: 'test.1' },
  { pattern: '*a*a*a*a*a*a', subject: 'aaaaaaaarrrrrrraaaraaarararaarararaarararaaa' }
]

const NONMATCH_CASES = [
  { pattern: 'foo.*', subject: 'snafoo.' },
  { pattern: 'test.?', subject: 'test.abc' },
  { pattern: '*stuff', subject: 'stuff to think about' },
  { pattern: 'test?test', subject: 'test123test' }
]

describe('util', () => {
  it('isTrue works', () => {
    TRUES.forEach((v) => {
      expect(isTrue(v)).to.equal(true)
      expect(isTrue(String(v))).to.equal(true)
    })
    FALSES.forEach((v) => {
      expect(isTrue(v)).to.equal(false)
      expect(isTrue(String(v))).to.equal(false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      expect(isFalse(v)).to.equal(true)
      expect(isFalse(String(v))).to.equal(true)
    })
    TRUES.forEach((v) => {
      expect(isFalse(v)).to.equal(false)
      expect(isFalse(String(v))).to.equal(false)
    })
  })

  it('globMatch works', () => {
    MATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(true)
    })

    NONMATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(false)
    })
  })

  it('resolveHostDetails resolves name and ip for localhost str input', () => {
    const hostDetails = resolveHostDetails('localhost')
    expect(hostDetails).to.deep.equal({
      'network.destination.ip': '127.0.0.1',
      'network.destination.name': 'localhost'
    })
  })

  it('resolveHostDetails resolves name and ip for loopback ip str input', () => {
    const hostDetails = resolveHostDetails('127.0.0.1')
    expect(hostDetails).to.deep.equal({
      'network.destination.ip': '127.0.0.1',
      'network.destination.name': 'localhost'
    })
  })

  it('resolveHostDetails resolves name and ip for loopback ipv6 str input', () => {
    const hostDetails = resolveHostDetails('::1')
    expect(hostDetails).to.deep.equal({
      'network.destination.ip': '::1',
      'network.destination.name': 'localhost'
    })
  })

  it('resolveHostDetails resolves ip for valid non-loopback ip str input ', () => {
    const hostDetails = resolveHostDetails('184.55.123.1')
    expect(hostDetails).to.deep.equal({
      'network.destination.ip': '184.55.123.1'
    })
  })

  it('resolveHostDetails resolves name for host name str input ', () => {
    const hostDetails = resolveHostDetails('mongo')
    expect(hostDetails).to.deep.equal({
      'network.destination.name': 'mongo'
    })
  })
})
