/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

describe('RUM correlation cookie failure', () => {
  it('continues running the test', () => {
    if (getTestEnvironment('MISSING_CY_NOW')) {
      expect(getTestEnvironment('DD_RUM_COOKIE_NOW_MISSING')).to.equal(true)
    } else {
      expect(getTestEnvironment('DD_RUM_COOKIE_ATTEMPTED')).to.equal(true)
    }
  })
})
