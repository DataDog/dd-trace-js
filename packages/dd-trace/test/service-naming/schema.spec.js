'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../setup/core')
const SchemaDefinition = require('../../src/service-naming/schemas/definition')

describe('Service naming', () => {
  let singleton

  describe('Version selection', () => {
    beforeEach(() => {
      singleton = require('../../src/service-naming')
    })

    afterEach(() => {
      delete require.cache[require.resolve('../../src/service-naming')]
    })

    it('Should default to v0 when required', () => {
      assert.strictEqual(singleton.version, 'v0')
    })

    it('Should grab the version given by `spanAttributeSchema`', () => {
      singleton.configure({ spanAttributeSchema: 'MyShinyNewVersion' })
      assert.strictEqual(singleton.version, 'MyShinyNewVersion')
    })

    describe('Name resolution proxy', () => {
      let singleton
      let versions
      const extra = { my: { extra: 'args' } }

      beforeEach(() => {
        versions = { v0: { getOpName: sinon.spy(), getServiceName: sinon.spy() } }
        singleton = require('../../src/service-naming')
        singleton.configure({ spanAttributeSchema: 'v0', service: 'test-service' })
        singleton.schemas = versions
      })

      it('should forward additional args to opName', () => {
        singleton.opName('messaging', 'producer', 'redis', extra)
        sinon.assert.calledWith(versions.v0.getOpName, 'messaging', 'producer', 'redis', extra)
      })

      it('should forward additional args to serviceName and add configured service', () => {
        singleton.serviceName('messaging', 'producer', 'redis', extra)
        sinon.assert.calledWith(versions.v0.getServiceName,
          'messaging',
          'producer',
          'redis',
          {
            tracerService: 'test-service',
            ...extra,
          }
        )
      })
    })
  })

  describe('Naming schema definition', () => {
    const dummySchema = {
      messaging: {
        inbound: {
          kafka: {
            opName: sinon.spy(),
            serviceName: sinon.spy(),
          },
        },
      },
    }

    const resolver = new SchemaDefinition(dummySchema)
    const extra = { my: { extra: 'args' } }

    describe('Operation name getter', () => {
      it('should passthrough operation name arguments', () => {
        resolver.getOpName('messaging', 'inbound', 'kafka', extra)
        sinon.assert.calledWith(dummySchema.messaging.inbound.kafka.opName, extra)
      })
    })

    describe('Service name getter', () => {
      it('should add service name and passthrough service name arguments', () => {
        const opts = { tracerService: 'test-service', ...extra }
        resolver.getServiceName('messaging', 'inbound', 'kafka', opts)
        sinon.assert.calledWith(dummySchema.messaging.inbound.kafka.serviceName, opts)
      })
    })
  })
})
