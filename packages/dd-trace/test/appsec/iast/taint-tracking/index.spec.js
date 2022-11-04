'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST TaintTracking', () => {
  let taintTracking
  const rewriter = {
    enableRewriter: sinon.spy(),
    disableRewriter: sinon.spy()
  }

  const taintTrackingOperations = {
    taintOperations: {
      enable: sinon.spy(),
      disable: sinon.spy()
    }
  }

  beforeEach(() => {
    taintTracking = proxyquire('../../../../src/appsec/iast/taint-tracking/', {
      './rewriter': rewriter,
      './operations': taintTrackingOperations
    })
  })

  afterEach(sinon.restore)

  it('Should enable both rewriter and taint tracking operations', () => {
    taintTracking.enableTaintTracking()
    expect(rewriter.enableRewriter).to.be.calledOnce
    expect(taintTrackingOperations.taintOperations.enable).to.be.calledOnce
  })

  it('Should disable both rewriter and taint tracking operations', () => {
    taintTracking.disableTaintTracking()
    expect(rewriter.disableRewriter).to.be.calledOnce
    expect(taintTrackingOperations.taintOperations.disable).to.be.calledOnce
  })
})
