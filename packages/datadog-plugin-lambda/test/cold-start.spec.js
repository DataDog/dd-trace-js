'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const {
  setSandboxInit,
  didFunctionColdStart,
  isProactiveInitialization,
  getSandboxInitTags,
  isManagedInstancesMode,
  isProvisionedConcurrency,
  _resetColdStart,
} = require('../src/cold-start')

describe('cold-start', () => {
  beforeEach(() => {
    _resetColdStart()
  })

  afterEach(() => {
    delete process.env.AWS_LAMBDA_INITIALIZATION_TYPE
  })

  describe('didFunctionColdStart', () => {
    it('returns true before any invocation', () => {
      assert.equal(didFunctionColdStart(), true)
    })

    it('returns true after first invocation within 10s gap', () => {
      setSandboxInit(1000, 2000)
      assert.equal(didFunctionColdStart(), true)
    })

    it('returns false after second invocation', () => {
      setSandboxInit(1000, 2000)
      setSandboxInit(1000, 3000)
      assert.equal(didFunctionColdStart(), false)
    })
  })

  describe('_resetColdStart', () => {
    it('resets state so next call is a cold start again', () => {
      setSandboxInit(1000, 2000)
      setSandboxInit(1000, 3000)
      assert.equal(didFunctionColdStart(), false)

      _resetColdStart()
      assert.equal(didFunctionColdStart(), true)
    })
  })

  describe('isProactiveInitialization', () => {
    it('returns false for normal cold start', () => {
      setSandboxInit(1000, 2000)
      assert.equal(isProactiveInitialization(), false)
    })

    it('returns true when gap exceeds 10 seconds', () => {
      setSandboxInit(1000, 12000)
      assert.equal(isProactiveInitialization(), true)
    })

    it('sets cold start to false when proactive initialization detected', () => {
      setSandboxInit(1000, 12000)
      assert.equal(didFunctionColdStart(), false)
    })

    it('returns false after reset and normal init', () => {
      setSandboxInit(1000, 12000)
      assert.equal(isProactiveInitialization(), true)

      _resetColdStart()
      setSandboxInit(1000, 2000)
      assert.equal(isProactiveInitialization(), false)
    })
  })

  describe('getSandboxInitTags', () => {
    it('returns cold_start:true tag on first invocation', () => {
      setSandboxInit(1000, 2000)
      const tags = getSandboxInitTags()
      assert.deepEqual(tags, ['cold_start:true'])
    })

    it('returns cold_start:false tag on second invocation', () => {
      setSandboxInit(1000, 2000)
      setSandboxInit(1000, 3000)
      const tags = getSandboxInitTags()
      assert.deepEqual(tags, ['cold_start:false'])
    })

    it('includes proactive_initialization tag when gap > 10s', () => {
      setSandboxInit(1000, 12000)
      const tags = getSandboxInitTags()
      assert.deepEqual(tags, ['cold_start:false', 'proactive_initialization:true'])
    })
  })

  describe('isManagedInstancesMode', () => {
    it('returns true when AWS_LAMBDA_INITIALIZATION_TYPE is lambda-managed-instances', () => {
      process.env.AWS_LAMBDA_INITIALIZATION_TYPE = 'lambda-managed-instances'
      assert.equal(isManagedInstancesMode(), true)
    })

    it('returns false when AWS_LAMBDA_INITIALIZATION_TYPE is something else', () => {
      process.env.AWS_LAMBDA_INITIALIZATION_TYPE = 'on-demand'
      assert.equal(isManagedInstancesMode(), false)
    })

    it('returns false when AWS_LAMBDA_INITIALIZATION_TYPE is not set', () => {
      delete process.env.AWS_LAMBDA_INITIALIZATION_TYPE
      assert.equal(isManagedInstancesMode(), false)
    })
  })

  describe('isProvisionedConcurrency', () => {
    it('returns true when AWS_LAMBDA_INITIALIZATION_TYPE is provisioned-concurrency', () => {
      process.env.AWS_LAMBDA_INITIALIZATION_TYPE = 'provisioned-concurrency'
      assert.equal(isProvisionedConcurrency(), true)
    })

    it('returns false when AWS_LAMBDA_INITIALIZATION_TYPE is something else', () => {
      process.env.AWS_LAMBDA_INITIALIZATION_TYPE = 'on-demand'
      assert.equal(isProvisionedConcurrency(), false)
    })

    it('returns false when AWS_LAMBDA_INITIALIZATION_TYPE is not set', () => {
      delete process.env.AWS_LAMBDA_INITIALIZATION_TYPE
      assert.equal(isProvisionedConcurrency(), false)
    })
  })
})
