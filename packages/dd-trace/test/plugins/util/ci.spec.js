const { getCIMetadata } = require('../../../src/plugins/util/ci')
const fs = require('fs')
const path = require('path')

describe('ci tags', () => {
  it('returns an empty object if the CI is not supported', () => {
    process.env = {}
    expect(getCIMetadata()).to.eql({})
  })

  const ciProviders = fs.readdirSync(path.join(__dirname, 'ci-env'))
  ciProviders.forEach(ciProvider => {
    const assertions = require(path.join(__dirname, 'ci-env', ciProvider))

    assertions.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info for spec ${index} from ${ciProvider}`, () => {
        process.env = env
        expect(getCIMetadata()).to.eql(expectedSpanTags)
      })
    })
  })
})
