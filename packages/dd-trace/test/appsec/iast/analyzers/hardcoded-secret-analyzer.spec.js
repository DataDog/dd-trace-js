'use strict'

const path = require('path')

const hardcodedSecretAnalyzer = require('../../../../src/appsec/iast/analyzers/hardcoded-secret-analyzer')
const { suite } = require('./resources/hardcoded-secrets-suite.json')

describe('Hardcoded Secret Analyzer', () => {
  const file = path.join(process.cwd(), '/path/to/file.js')
  const line = 42
  const column = 3

  let report
  beforeEach(() => {
    report = sinon.stub(hardcodedSecretAnalyzer, '_report')
  })

  afterEach(sinon.restore)

  suite.forEach((testCase) => {
    testCase.samples.forEach(sample => {
      it(`should match rule ${testCase.id} with value ${sample}`, () => {
        hardcodedSecretAnalyzer.analyze({
          file,
          literals: [{
            value: sample,
            locations: [{
              line,
              column
            }]
          }]
        })

        expect(report).to.be.calledOnceWithExactly({ file: 'path/to/file.js', line, column, data: testCase.id })
      })
    })
  })

  it('should not fail with an malformed secrets', () => {
    expect(() => hardcodedSecretAnalyzer.analyze(undefined)).not.to.throw()
    expect(() => hardcodedSecretAnalyzer.analyze({ file: undefined })).not.to.throw()
    expect(() => hardcodedSecretAnalyzer.analyze({ file, literals: undefined })).not.to.throw()
    expect(() => hardcodedSecretAnalyzer.analyze({ file, literals: [{ value: undefined }] })).not.to.throw()
    expect(() => hardcodedSecretAnalyzer.analyze({ file, literals: [{ value: 'test' }] })).not.to.throw()
  })

  it('should not report secrets in line 0', () => {
    hardcodedSecretAnalyzer.analyze({
      file,
      literals: [{ value: 'test', line: 0 }]
    })

    expect(report).to.not.be.called
  })
})
