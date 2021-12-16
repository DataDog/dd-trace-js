const fs = require('fs')
const path = require('path')

const proxyquire = require('proxyquire')
const sanitizedExecStub = sinon.stub().returns('')

const { getCIMetadata } = require('../../../src/plugins/util/ci')
const { getGitMetadata } = proxyquire('../../../src/plugins/util/git', {
  './exec': {
    'sanitizedExec': sanitizedExecStub
  }
})
const { getTestEnvironmentMetadata } = proxyquire('../../../src/plugins/util/test', {
  './git': {
    'getGitMetadata': getGitMetadata
  }
})

describe('test environment data', () => {
  it('getTestEnvironmentMetadata can include service name', () => {
    const tags = getTestEnvironmentMetadata('jest', { service: 'service-name' })
    expect(tags).to.contain({ 'service.name': 'service-name' })
  })
  it('getCIMetadata returns an empty object if the CI is not supported', () => {
    process.env = {}
    expect(getCIMetadata()).to.eql({})
  })

  const ciProviders = fs.readdirSync(path.join(__dirname, 'ci-env'))
  ciProviders.forEach(ciProvider => {
    const assertions = require(path.join(__dirname, 'ci-env', ciProvider))

    assertions.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info for spec ${index} from ${ciProvider}`, () => {
        process.env = env
        const tags = getTestEnvironmentMetadata()

        expect(tags).to.contain(expectedSpanTags)
      })
    })
  })
})
