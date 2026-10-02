'use strict'

function fail () { throw new Error('failure') }

describe('no override', () => {
  it('fails', fail)
})
describe('numeric suite', { retries: 2 }, () => {
  it('fails', fail)
  describe('inherited', () => {
    it('fails', fail)
  })
  describe('zero suite', { retries: 0 }, () => {
    it('fails', fail)
  })
  it('zero test', { retries: 0 }, fail)
  it('test override', { retries: { runMode: 1 } }, fail)
})
describe('object suite', { retries: { runMode: 3 } }, () => {
  it('fails', fail)
})
