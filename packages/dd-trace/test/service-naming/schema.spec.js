const { namingResolver } = require('../../src/service-naming/schemas/util')

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
  })

  describe('Naming schema resolution', () => {
    function withResolverFunction (displayName, functionName, fallback) {
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
      const resolver = namingResolver(dummySchema)

      describe(`${displayName}`, () => {
        const func = resolver[functionName]
        it('should fallback on inexistent plugin', () => {
          expect(func('messaging', 'inbound', 'foo')).to.be.equal(fallback)
        })
        it('should fallback on inexistent i/o dir', () => {
          expect(func('messaging', 'foo', 'kafka')).to.be.equal(fallback)
        })
        it('should fallback on inexistent type', () => {
          expect(func('foo', 'inbound', 'kafka')).to.be.equal(fallback)
        })
        it('should passthrough arguments to the schema function', () => {
          const args = { my: { complex: 'args' } }
          func('messaging', 'inbound', 'kafka', args)
          expect(dummySchema.messaging.inbound.kafka[functionName]).to.have.been.calledWith(args)
        })
      })
    }

    withResolverFunction('Operation name', 'opName', 'unnamed-node-operation')
    withResolverFunction('Service name', 'serviceName', 'unnamed-node-service')
  })
})
