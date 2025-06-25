const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const SchemaDefinition = require('../../src/service-naming/schemas/definition')

t.test('Service naming', t => {
  let singleton

  t.test('Version selection', t => {
    t.beforeEach(() => {
      singleton = require('../../src/service-naming')
    })

    t.afterEach(() => {
      delete require.cache[require.resolve('../../src/service-naming')]
    })

    t.test('Should default to v0 when required', t => {
      expect(singleton.version).to.be.equal('v0')
      t.end()
    })

    t.test('Should grab the version given by `spanAttributeSchema`', t => {
      singleton.configure({ spanAttributeSchema: 'MyShinyNewVersion' })
      expect(singleton.version).to.be.equal('MyShinyNewVersion')
      t.end()
    })

    t.test('Name resolution proxy', t => {
      let singleton
      let versions
      const extra = { my: { extra: 'args' } }

      t.beforeEach(() => {
        versions = { v0: { getOpName: sinon.spy(), getServiceName: sinon.spy() } }
        singleton = require('../../src/service-naming')
        singleton.configure({ spanAttributeSchema: 'v0', service: 'test-service' })
        singleton.schemas = versions
      })

      t.test('should forward additional args to opName', t => {
        singleton.opName('messaging', 'producer', 'redis', extra)
        expect(versions.v0.getOpName).to.have.been.calledWith('messaging', 'producer', 'redis', extra)
        t.end()
      })

      t.test('should forward additional args to serviceName and add configured service', t => {
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
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('Naming schema definition', t => {
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

    t.test('Item resolver', t => {
      t.test('should answer undefined on inexistent plugin', t => {
        expect(resolver.getSchemaItem('messaging', 'inbound', 'foo')).to.be.equal(undefined)
        t.end()
      })

      t.test('should answer undefined on inexistent i/o dir', t => {
        expect(resolver.getSchemaItem('messaging', 'foo', 'kafka')).to.be.equal(undefined)
        t.end()
      })

      t.test('should answer undefined on inexistent type', t => {
        expect(resolver.getSchemaItem('foo', 'inbound', 'kafka')).to.be.equal(undefined)
        t.end()
      })
      t.end()
    })

    t.test('Operation name getter', t => {
      t.test('should passthrough operation name arguments', t => {
        resolver.getOpName('messaging', 'inbound', 'kafka', extra)
        expect(dummySchema.messaging.inbound.kafka.opName).to.be.calledWith(extra)
        t.end()
      })
      t.end()
    })

    t.test('Service name getter', t => {
      t.test('should add service name and passthrough service name arguments', t => {
        const opts = { tracerService: 'test-service', ...extra }
        resolver.getServiceName('messaging', 'inbound', 'kafka', opts)
        expect(dummySchema.messaging.inbound.kafka.serviceName).to.be.calledWith(opts)
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
