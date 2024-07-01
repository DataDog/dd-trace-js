'use strict'

const { relative } = require('path')

require('../../setup/tap')

const {
  getCallSites,
  getUserLandCallsites,
  getRelativeFilename
} = require('../../../src/plugins/util/stacktrace')

describe('stacktrace utils', () => {
  it('should get callsites array from getCallsites', () => {
    expectCallsitesArray(getCallSites())
  })

  it('should get only userland callsites array from getUserLandCallsites', function helloWorld () {
    const callsites = getUserLandCallsites()
    expectCallsitesArray(callsites)
    const callsite = callsites[0]
    expect(callsite.getFileName()).to.equal(__filename)
    expect(callsite.getFunctionName()).to.equal('helloWorld')
  })

  it('getRelativeFilename', () => {
    expect(getRelativeFilename(__filename)).to.equal(relative(process.cwd(), __filename))
    expect(getRelativeFilename('file://' + __filename)).to.equal(relative(process.cwd(), __filename))
    expect(getRelativeFilename('file://' + __filename, true)).to.equal(relative(process.cwd(), __filename))
  })
})

function expectCallsitesArray (callsites) {
  expect(callsites).to.be.an('array')
  expect(callsites.length).to.be.gt(0)
  callsites.forEach((callsite) => {
    expect(callsite).to.be.an.instanceof(Object)
    expect(callsite.constructor.name).to.equal('CallSite')
    expect(callsite.getFileName).to.be.an.instanceof(Function)
  })
}
