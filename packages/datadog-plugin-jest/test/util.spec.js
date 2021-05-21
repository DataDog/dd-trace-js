const { getFormattedJestTestParameters } = require('../src/util')

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
