'use strict'

const testCount = Number(process.env.DD_REPRO_TEST_COUNT || 2_000)
const parameterBytes = Number(process.env.DD_REPRO_PARAMETER_BYTES || 6_000)
const payloadSource = process.env.DD_REPRO_PAYLOAD_SOURCE || 'name'
const largeValue = 'x'.repeat(parameterBytes)

if (payloadSource === 'parameters') {
  const cases = new Array(testCount)

  for (let index = 0; index < testCount; index++) {
    cases[index] = [index, largeValue]
  }

  test.each(cases)('exports a large parameter for test %i', (index, parameter) => {
    expect(index).toBeGreaterThanOrEqual(0)
    expect(parameter).toHaveLength(parameterBytes)
  })
} else if (payloadSource === 'name') {
  for (let index = 0; index < testCount; index++) {
    test(`exports a large name for test ${index}: ${largeValue}`, () => {
      expect(index).toBeGreaterThanOrEqual(0)
    })
  }
} else {
  throw new Error(`Unknown DD_REPRO_PAYLOAD_SOURCE: ${payloadSource}`)
}
