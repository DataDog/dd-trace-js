'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('./setup/core')

const { enableGCPPubSubPushSubscription, isSomethingUnderNDA } = require('../src/serverless')

describe('enableGCPPubSubPushSubscription', () => {
  const originalKService = process.env.K_SERVICE
  const originalGcpPubsubPush = process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED

  afterEach(() => {
    if (originalKService === undefined) delete process.env.K_SERVICE
    else process.env.K_SERVICE = originalKService
    if (originalGcpPubsubPush === undefined) delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    else process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = originalGcpPubsubPush
  })

  it('is false when K_SERVICE is not set', () => {
    delete process.env.K_SERVICE
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })

  it('is true when K_SERVICE is set and the env var defaults to true', () => {
    process.env.K_SERVICE = 'svc'
    delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    assert.strictEqual(enableGCPPubSubPushSubscription(), true)
  })

  it('is false when the user opts out via DD_TRACE_GCP_PUBSUB_PUSH_ENABLED=false', () => {
    process.env.K_SERVICE = 'svc'
    process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = 'false'
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })
})

describe('serverless', () => {
  describe('isSomethingUnderNDA', () => {
    const SOMETHING_UNDER_NDA_ENV = 'SOMETHING_UNDER_NDA'
    let priorSomethingUnderNDA

    beforeEach(() => {
      priorSomethingUnderNDA = process.env[SOMETHING_UNDER_NDA_ENV]
      delete process.env[SOMETHING_UNDER_NDA_ENV]
    })

    afterEach(() => {
      if (priorSomethingUnderNDA === undefined) delete process.env[SOMETHING_UNDER_NDA_ENV]
      else process.env[SOMETHING_UNDER_NDA_ENV] = priorSomethingUnderNDA
    })

    it('should return false when not under something-under-nda', () => {
      assert.strictEqual(isSomethingUnderNDA(), false)
    })

    it('should return true when under something-under-nda', () => {
      process.env[SOMETHING_UNDER_NDA_ENV] = 'something-under-nda'

      assert.strictEqual(isSomethingUnderNDA(), true)
    })
  })
})
