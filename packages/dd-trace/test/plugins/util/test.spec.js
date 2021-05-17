const { getTestParametersString, getFormattedJestTestParameters } = require('../../../src/plugins/util/test')

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
describe('getFormattedJestTestParameters', () => {
  it('returns formatted parameters for arrays', () => {
    const result = getFormattedJestTestParameters([[[1, 2], [3, 4]]])
    expect(result).to.eql([[1, 2], [3, 4]])
  })
  it('returns formatted parameters for strings', () => {
    const result = getFormattedJestTestParameters([['\n    a    | b    | expected\n    '], 1, 2, 3, 3, 5, 8, 0, 1, 1])
    expect(result).to.eql([{ a: 1, b: 2, expected: 3 }, { a: 3, b: 5, expected: 8 }, { a: 0, b: 1, expected: 1 }])
  })
  it('does not crash for invalid inputs', () => {
    const resultUndefined = getFormattedJestTestParameters(undefined)
    const resultEmptyArray = getFormattedJestTestParameters([])
    const resultObject = getFormattedJestTestParameters({})
    expect(resultEmptyArray).to.eql(undefined)
    expect(resultUndefined).to.eql(undefined)
    expect(resultObject).to.eql(undefined)
  })
})
