'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
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
      expect(singleton.version).to.be.equal('v0')
    })

    it('Should grab the version given by `spanAttributeSchema`', () => {
      singleton.configure({ spanAttributeSchema: 'MyShinyNewVersion' })
      expect(singleton.version).to.be.equal('MyShinyNewVersion')
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
        expect(versions.v0.getOpName).to.have.been.calledWith('messaging', 'producer', 'redis', extra)
      })

      it('should forward additional args to serviceName and add configured service', () => {
        singleton.serviceName('messaging', 'producer', 'redis', extra)
        expect(versions.v0.getServiceName).to.have.been.calledWith(
          'messaging',
          'producer',
          'redis',
          {
            tracerService: 'test-service',
            ...extra
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
            serviceName: sinon.spy()
          }
        }
      }
    }

    const resolver = new SchemaDefinition(dummySchema)
    const extra = { my: { extra: 'args' } }

    describe('Operation name getter', () => {
      it('should passthrough operation name arguments', () => {
        resolver.getOpName('messaging', 'inbound', 'kafka', extra)
        expect(dummySchema.messaging.inbound.kafka.opName).to.be.calledWith(extra)
      })
    })

    describe('Service name getter', () => {
      it('should add service name and passthrough service name arguments', () => {
        const opts = { tracerService: 'test-service', ...extra }
        resolver.getServiceName('messaging', 'inbound', 'kafka', opts)
        expect(dummySchema.messaging.inbound.kafka.serviceName).to.be.calledWith(opts)
      })
    })

    describe('Auto-registration for unknown integrations', () => {
      it('should auto-generate operation names for unknown messaging producers', () => {
        const result = resolver.getOpName('messaging', 'producer', 'bee-queue', {})
        expect(result).to.equal('bee-queue.send')
      })

      it('should auto-generate operation names for unknown messaging consumers', () => {
        const result = resolver.getOpName('messaging', 'consumer', 'bee-queue', {})
        expect(result).to.equal('bee-queue.process')
      })

      it('should auto-generate operation names for unknown web servers', () => {
        const result = resolver.getOpName('web', 'server', 'polka', {})
        expect(result).to.equal('polka.request')
      })

      it('should auto-generate operation names for unknown storage clients', () => {
        const result = resolver.getOpName('storage', 'client', 'better-sqlite3', {})
        expect(result).to.equal('better-sqlite3.query')
      })

      it('should use identityService for unknown integrations', () => {
        const result = resolver.getServiceName('messaging', 'producer', 'bee-queue', { tracerService: 'my-app' })
        expect(result).to.equal('my-app')
      })

      it('should handle completely unknown type/kind combinations', () => {
        const result = resolver.getOpName('unknown-type', 'unknown-kind', 'unknown-plugin', {})
        expect(result).to.equal('unknown-plugin.operation')
      })
    })
  })
})
