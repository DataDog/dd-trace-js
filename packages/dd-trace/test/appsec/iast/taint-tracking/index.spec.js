'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('IAST TaintTracking', () => {
  let taintTracking
  const config = {
    iast: {
      maxConcurrentRequests: 2,
    },
  }

  const taintTrackingOperations = {
    enableTaintOperations: sinon.spy(),
    disableTaintOperations: sinon.spy(),
    setMaxTransactions: sinon.spy(),
  }

  const taintTrackingPlugin = {
    enable: sinon.spy(),
    disable: sinon.spy(),
  }

  beforeEach(() => {
    taintTracking = proxyquire('../../../../src/appsec/iast/taint-tracking/', {
      './operations': taintTrackingOperations,
      './plugin': taintTrackingPlugin,
    })
  })

  afterEach(sinon.restore)

  it('Should enable rewriter, taint tracking operations and plugin', () => {
    taintTracking.enableTaintTracking(config.iast)
    sinon.assert.calledOnce(taintTrackingOperations.enableTaintOperations)
    sinon.assert.calledOnce(taintTrackingPlugin.enable)
    sinon.assert.calledOnceWithExactly(taintTrackingOperations.setMaxTransactions, config.iast.maxConcurrentRequests)
  })

  it('Should disable both rewriter, taint tracking operations, plugin', () => {
    taintTracking.disableTaintTracking()
    sinon.assert.calledOnce(taintTrackingOperations.disableTaintOperations)
    sinon.assert.calledOnce(taintTrackingPlugin.disable)
  })
})
