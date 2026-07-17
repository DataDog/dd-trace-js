'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

require('./setup/core')

describe('microvm-identity-refresh', () => {
  const updateChannel = dc.channel('datadog:identity:update')

  const id = { reseed: sinon.stub() }
  const config = { refreshRuntimeId: sinon.stub() }
  const remoteConfig = { refreshClientId: sinon.stub() }

  before(() => {
    proxyquire('../src/microvm-identity-refresh', {
      './id': id,
      './config': config,
      './remote_config': remoteConfig,
    })
  })

  beforeEach(() => {
    id.reseed.resetHistory()
    config.refreshRuntimeId.resetHistory()
    remoteConfig.refreshClientId.resetHistory()
  })

  it('should call id.reseed, config.refreshRuntimeId, and remote_config.refreshClientId when published', () => {
    const dtConfig = { tags: {} }

    updateChannel.publish(dtConfig)

    sinon.assert.calledOnce(id.reseed)
    sinon.assert.calledOnceWithExactly(config.refreshRuntimeId, dtConfig)
    sinon.assert.calledOnceWithExactly(remoteConfig.refreshClientId, dtConfig)
  })

  it('should call reseed, then refreshRuntimeId, then refreshClientId in order', () => {
    updateChannel.publish({ tags: {} })

    assert.ok(id.reseed.calledBefore(config.refreshRuntimeId))
    assert.ok(config.refreshRuntimeId.calledBefore(remoteConfig.refreshClientId))
  })
})
