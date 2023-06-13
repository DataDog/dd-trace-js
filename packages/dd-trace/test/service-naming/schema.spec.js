require('../setup/tap')

const { expect } = require('chai')
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
        sinon.assert.calledWith(versions.v0.getOpName, 'messaging', 'producer', 'redis', extra)
      })

      it('should forward additional args to serviceName and add configured service', () => {
        singleton.serviceName('messaging', 'producer', 'redis', extra)
        sinon.assert.calledWith(versions.v0.getServiceName, 'messaging', 'producer', 'redis', 'test-service', extra)
      })

      it('Should use DD_SERVICE when using `v0` schema & `DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED`', () => {
        singleton.configure({
          spanAttributeSchema: 'v0',
          traceRemoveIntegrationServiceNamesEnabled: true,
          service: 'test-service'
        })

        const serviceName = singleton.serviceName('messaging', 'producer', 'redis', extra)
        expect(singleton.version).to.be.equal('v0')
        expect(serviceName).to.be.equal('test-service')
        expect(versions.v0.getServiceName).to.not.have.been.called
      })

      it('Should not use DD_SERVICE with schema=`v0` & `DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED` unset', () => {
        singleton.serviceName('messaging', 'producer', 'redis', extra)
        expect(singleton.version).to.be.equal('v0')
        sinon.assert.calledWith(
          versions.v0.getServiceName,
          'messaging',
          'producer',
          'redis',
          'test-service',
          extra
        )
      })

      it('Should not set the service to DD_SERVICE when using `v1` schema', () => {
        versions.v1 = { getOpName: sinon.spy(), getServiceName: sinon.spy() }
        singleton.configure({
          spanAttributeSchema: 'v1',
          traceRemoveIntegrationServiceNamesEnabled: true,
          service: 'test-service'
        })
        singleton.schemas = versions

        singleton.serviceName('messaging', 'producer', 'redis', extra)
        expect(singleton.version).to.be.equal('v1')
        sinon.assert.calledWith(
          versions.v1.getServiceName,
          'messaging',
          'producer',
          'redis',
          'test-service',
          extra
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

    describe('Item resolver', () => {
      it('should answer undefined on inexistent plugin', () => {
        expect(resolver.getSchemaItem('messaging', 'inbound', 'foo')).to.be.equal(undefined)
      })
      it('should answer undefined on inexistent i/o dir', () => {
        expect(resolver.getSchemaItem('messaging', 'foo', 'kafka')).to.be.equal(undefined)
      })
      it('should answer undefined on inexistent type', () => {
        expect(resolver.getSchemaItem('foo', 'inbound', 'kafka')).to.be.equal(undefined)
      })
    })

    describe('Operation name getter', () => {
      it('should passthrough operation name arguments', () => {
        resolver.getOpName('messaging', 'inbound', 'kafka', extra)
        expect(dummySchema.messaging.inbound.kafka.opName).to.be.calledWith(extra)
      })
    })
    describe('Service name getter', () => {
      it('should add service name and passthrough service name arguments', () => {
        resolver.getServiceName('messaging', 'inbound', 'kafka', 'test-service', extra)
        expect(dummySchema.messaging.inbound.kafka.serviceName).to.be.calledWith('test-service', extra)
      })
    })
  })
})
