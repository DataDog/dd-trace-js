/* eslint-disable */
describe('screenshot suite', () => {
  it('fails and takes a screenshot', () => {
    assert.fail('intentional failure to trigger screenshotOnRunFailure')
  })

  it('passes without a screenshot', () => {
    // intentionally no failure, no screenshot
  })
})
