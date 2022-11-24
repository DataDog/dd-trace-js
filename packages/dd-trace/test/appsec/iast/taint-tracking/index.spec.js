'use strict'

require('../../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('IAST TaintTracking', () => {
  let taintTracking
  const rewriter = {
    enableRewriter: sinon.spy(),
    disableRewriter: sinon.spy()
  }

  const taintTrackingOperations = {
    enableTaintOperations: sinon.spy(),
    disableTaintOperations: sinon.spy()
  }

  const taintTrackingPlugin = {
    enable: sinon.spy(),
    disable: sinon.spy()
  }

  beforeEach(() => {
    taintTracking = proxyquire('../../../../src/appsec/iast/taint-tracking/', {
      './rewriter': rewriter,
      './operations': taintTrackingOperations,
      './plugin': taintTrackingPlugin
    })
  })

  afterEach(() => { sinon.restore() })

  it('Should enable rewriter, taint tracking operations and plugin', () => {
    taintTracking.enableTaintTracking()
    expect(rewriter.enableRewriter).to.be.calledOnce
    expect(taintTrackingOperations.enableTaintOperations).to.be.calledOnce
    expect(taintTrackingPlugin.enable).to.be.calledOnce
  })

  it('Should disable both rewriter, taint tracking operations, plugin', () => {
    taintTracking.disableTaintTracking()
    expect(rewriter.disableRewriter).to.be.calledOnce
    expect(taintTrackingOperations.disableTaintOperations).to.be.calledOnce
    expect(taintTrackingPlugin.disable).to.be.calledOnce
  })
})
