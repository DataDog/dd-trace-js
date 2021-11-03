const { getTestParametersString, getTestSuitePath } = require('../../../src/plugins/util/test')

describe('getTestParametersString', () => {
  it('returns formatted test parameters and removes params from input', () => {
    const input = { 'test_stuff': [['params'], [{ b: 'c' }]] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params'], metadata: {} })
    )
    expect(input).to.eql({ 'test_stuff': [[{ b: 'c' }]] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: [{ b: 'c' }], metadata: {} })
    )
    expect(input).to.eql({ 'test_stuff': [] })
  })
  it('does not crash when test name is not found and does not modify input', () => {
    const input = { 'test_stuff': [['params'], ['params2']] }
    expect(getTestParametersString(input, 'test_not_present')).to.equal('')
    expect(input).to.eql({ 'test_stuff': [['params'], ['params2']] })
  })
  it('does not crash when parameters can not be serialized and removes params from input', () => {
    const circular = { a: 'b' }
    circular.b = circular

    const input = { 'test_stuff': [[circular], ['params2']] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal('')
    expect(input).to.eql({ 'test_stuff': [['params2']] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params2'], metadata: {} })
    )
  })
})

describe('getTestSuitePath', () => {
  it('returns sourceRoot if the test path is falsy', () => {
    const sourceRoot = '/users/opt'
    const testSuitePath = getTestSuitePath(undefined, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
  })
  it('returns sourceRoot if the test path has the same value', () => {
    const sourceRoot = '/users/opt'
    const testSuiteAbsolutePath = sourceRoot
    const testSuitePath = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
  })
})
