'use strict'

const vulnerabilityFormatter = require('../../../../src/appsec/iast/vulnerabilities-formatter/vulnerability-formatter')

const { suite } = require('./resources/evidence-redaction-suite.json')

function doTest (testCase, parameter) {
  let { description, input, expected } = testCase
  if (parameter) {
    description = description.split(parameter.name).join(parameter.value)
    input = JSON.parse(JSON.stringify(input).split(parameter.name).join(parameter.value))
    expected = JSON.parse(JSON.stringify(expected).split(parameter.name).join(parameter.value))
  }

  it(description, () => {
    const testInput = input.map(i => (
      {
        ...i,
        location: {}
      }
    ))
    const formattedVulnerabilities = vulnerabilityFormatter.toJson(testInput)
    const vulnerabilitiesToCompare = formattedVulnerabilities.vulnerabilities.map(v => (
      {
        type: v.type,
        evidence: v.evidence
      }
    ))
    expect(vulnerabilitiesToCompare).to.deep.equal(expected.vulnerabilities, 'Vulnerabilities does not match')

    if (expected.sources) {
      expect(formattedVulnerabilities.sources).to.deep.equal(expected.sources, 'Sources does not match')
    }
  })
}

describe('Evidence redaction', () => {
  describe('Vulnerability redaction', () => {
    suite.filter(testCase => testCase.type === 'VULNERABILITIES').forEach((testCase) => {
      if (!testCase.parameters) {
        doTest(testCase)
      } else {
        for (const name in testCase.parameters) {
          testCase.parameters[name].forEach(value => {
            doTest(testCase, { name, value })
          })
        }
      }
    })
  })
})
