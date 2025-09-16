'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('../setup/core')

const ffeModule = require('../../src/ffe')

describe('FFE', () => {
  let ffe

  beforeEach(() => {
    ffe = ffeModule.enable()
  })

  describe('constructor', () => {
    it('should initialize with empty ufc store', () => {
      expect(ffe.ufc).to.be.an('object')
      expect(Object.keys(ffe.ufc)).to.have.length(0)
    })
  })

  describe('setConfig', () => {
    it('should store UFC configuration by configId', () => {
      const configId = 'org-42-env-prod'
      const ufcData = {
        flags: {
          'example-flag': {
            key: 'example-flag',
            enabled: true,
            variationType: 'BOOLEAN',
            variations: {
              true: { key: 'true', value: true },
              false: { key: 'false', value: false }
            },
            allocations: []
          }
        }
      }

      ffe.setConfig(configId, ufcData)

      expect(ffe.ufc[configId]).to.deep.equal(ufcData)
    })

    it('should overwrite existing config for same configId', () => {
      const configId = 'org-42-env-prod'
      const initialUfc = { flags: { flag1: { enabled: false } } }
      const updatedUfc = { flags: { flag1: { enabled: true } } }

      ffe.setConfig(configId, initialUfc)
      ffe.setConfig(configId, updatedUfc)

      expect(ffe.ufc[configId]).to.deep.equal(updatedUfc)
    })

    it('should store multiple configs with different configIds', () => {
      const prodConfig = { flags: { 'prod-flag': { enabled: true } } }
      const stagingConfig = { flags: { 'staging-flag': { enabled: false } } }

      ffe.setConfig('org-42-env-prod', prodConfig)
      ffe.setConfig('org-42-env-staging', stagingConfig)

      expect(ffe.ufc['org-42-env-prod']).to.deep.equal(prodConfig)
      expect(ffe.ufc['org-42-env-staging']).to.deep.equal(stagingConfig)
    })
  })

  describe('getConfig', () => {
    it('should return stored UFC configuration', () => {
      const configId = 'org-42-env-prod'
      const ufcData = { flags: { 'test-flag': { enabled: true } } }

      ffe.setConfig(configId, ufcData)
      const retrieved = ffe.getConfig(configId)

      expect(retrieved).to.deep.equal(ufcData)
    })

    it('should return undefined for non-existent configId', () => {
      const retrieved = ffe.getConfig('non-existent-config')
      expect(retrieved).to.be.undefined
    })
  })

  describe('removeConfig', () => {
    it('should remove UFC configuration by configId', () => {
      const configId = 'org-42-env-prod'
      const ufcData = { flags: { 'test-flag': { enabled: true } } }

      ffe.setConfig(configId, ufcData)
      expect(ffe.ufc[configId]).to.exist

      ffe.removeConfig(configId)
      expect(ffe.ufc[configId]).to.be.undefined
    })

    it('should not affect other configs when removing one', () => {
      const prodConfig = { flags: { 'prod-flag': { enabled: true } } }
      const stagingConfig = { flags: { 'staging-flag': { enabled: false } } }

      ffe.setConfig('org-42-env-prod', prodConfig)
      ffe.setConfig('org-42-env-staging', stagingConfig)

      ffe.removeConfig('org-42-env-prod')

      expect(ffe.ufc['org-42-env-prod']).to.be.undefined
      expect(ffe.ufc['org-42-env-staging']).to.deep.equal(stagingConfig)
    })

    it('should handle removing non-existent configId gracefully', () => {
      expect(() => ffe.removeConfig('non-existent')).to.not.throw()
    })
  })
})
