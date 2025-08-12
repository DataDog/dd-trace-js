'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST TaintTracking', () => {
  let taintTracking
  const config = {
    iast: {
      maxConcurrentRequests: 2
    }
  }

  const taintTrackingOperations = {
    enableTaintOperations: sinon.spy(),
    disableTaintOperations: sinon.spy(),
    setMaxTransactions: sinon.spy()
  }

  const taintTrackingPlugin = {
    enable: sinon.spy(),
    disable: sinon.spy()
  }

  beforeEach(() => {
    taintTracking = proxyquire('../../../../src/appsec/iast/taint-tracking/', {
      './operations': taintTrackingOperations,
      './plugin': taintTrackingPlugin
    })
  })

  afterEach(sinon.restore)

  it('Should enable rewriter, taint tracking operations and plugin', () => {
    taintTracking.enableTaintTracking(config.iast)
    expect(taintTrackingOperations.enableTaintOperations).to.be.calledOnce
    expect(taintTrackingPlugin.enable).to.be.calledOnce
    expect(taintTrackingOperations.setMaxTransactions)
      .to.have.been.calledOnceWithExactly(config.iast.maxConcurrentRequests)
  })

  it('Should disable both rewriter, taint tracking operations, plugin', () => {
    taintTracking.disableTaintTracking()
    expect(taintTrackingOperations.disableTaintOperations).to.be.calledOnce
    expect(taintTrackingPlugin.disable).to.be.calledOnce
  })
})
