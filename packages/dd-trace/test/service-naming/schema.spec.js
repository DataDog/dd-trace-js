const Naming = require('../service-naming')

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

  it('Should reload based on environment variable', () => {
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v1'
    Naming.reload()
    expect(Naming.schema).to.be.equal.to('v1')
  })
})
