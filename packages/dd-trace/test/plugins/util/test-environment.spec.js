'use strict'

require('../../setup/tap')

const fs = require('fs')
const path = require('path')

const proxyquire = require('proxyquire')
const execFileSyncStub = sinon.stub().returns('')

const { getCIMetadata } = require('../../../src/plugins/util/ci')
const { CI_ENV_VARS, CI_NODE_LABELS } = require('../../../src/plugins/util/tags')

const { getGitMetadata } = proxyquire('../../../src/plugins/util/git', {
  'child_process': {
    'execFileSync': execFileSyncStub
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
        const { DD_TEST_CASE_NAME: testCaseName } = env
        const { [CI_ENV_VARS]: envVars, [CI_NODE_LABELS]: nodeLabels, ...restOfTags } = getTestEnvironmentMetadata()
        const {
          [CI_ENV_VARS]: expectedEnvVars,
          [CI_NODE_LABELS]: expectedNodeLabels,
          ...restOfExpectedTags
        } = expectedSpanTags

        expect(restOfTags, testCaseName ? `${testCaseName} has failed.` : undefined).to.contain(restOfExpectedTags)
        // `CI_ENV_VARS` key contains a dictionary, so we do a `eql` comparison
        if (envVars && expectedEnvVars) {
          expect(JSON.parse(envVars)).to.eql(JSON.parse(expectedEnvVars))
        }
        // `CI_NODE_LABELS` key contains an array, so we do a `to.have.same.members` comparison
        if (nodeLabels && expectedNodeLabels) {
          expect(JSON.parse(nodeLabels)).to.have.same.members(JSON.parse(expectedNodeLabels))
        }
      })
    })
  })
})
