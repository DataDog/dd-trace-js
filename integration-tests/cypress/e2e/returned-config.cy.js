/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

describe('returned config', () => {
  it('uses env from setupNodeEvents return value', () => {
    expect(getTestEnvironment('RETURNED_CONFIG_FLAG')).to.equal('true')
  })
})
