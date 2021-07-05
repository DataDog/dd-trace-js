'use strict'

const { expect } = require('chai')
const { LibAppSec } = require('../native')
const TEST_RULE = require('./testRule.json')

describe('LibAppSec', () => {
  beforeEach(() => {
    LibAppSec.clearAll
  })

  it('should refuse a bad config', () => {
    const badInit = () => new LibAppSec('{')
    expect(badInit).to.throw()
  })

  it('should run the WAD e2e', () => {
    const lib = new LibAppSec(JSON.stringify(TEST_RULE))
    const r1 = lib.run({}, 10000)
    expect(r1.status).to.equal(undefined)
    expect(r1.record).to.equal(undefined)
    const r2 = lib.run({ 'server.request.uri.raw': '/<script>' }, 10000)
    expect(r2.status).to.equal('raise')
    expect(r2.record).to.not.equal(undefined)
    const r3 = lib.run({
      'server.request.headers.no_cookies': {
        host: 'localhost:1337', 'user-agent': 'Arachni/v1'
      }
    }, 10000)
    expect(r3.status).to.equal(undefined)
    expect(r3.record).to.not.equal(undefined)
  })
})
