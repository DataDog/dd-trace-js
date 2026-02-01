'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const iast = require('../../../../src/appsec/iast')
const { NameAndValue, ValueOnly } = require('../../../../src/appsec/iast/analyzers/hardcoded-rule-type')
const hardcodedSecretAnalyzer = require('../../../../src/appsec/iast/analyzers/hardcoded-secret-analyzer')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')
const { getConfigFresh } = require('../../../helpers/config')
const agent = require('../../../plugins/agent')
const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
const { suite } = require('./resources/hardcoded-secrets-suite.json')

describe('Hardcoded Secret Analyzer', () => {
  describe('unit test', () => {
    const relFile = path.join('path', 'to', 'file.js')
    const file = path.join(process.cwd(), relFile)
    const line = 42
    const column = 3

    let report

    beforeEach(() => {
      report = sinon.stub(hardcodedSecretAnalyzer, '_report')
    })

    afterEach(sinon.restore)

    suite.forEach((testCase) => {
      testCase.samples.forEach((sample, sampleIndex) => {
        // sample values are arrays containing the parts of the original token
        it(`should match rule ${testCase.id} with #${sampleIndex + 1}`, () => {
          const value = sample.join('')
          const ident = testCase.type === NameAndValue ? value.split(' = ')[0] : undefined

          hardcodedSecretAnalyzer.analyze({
            file,
            literals: [{
              value,
              locations: [{
                line,
                column,
                ident,
              }],
            }],
          })

          assertObjectContains([NameAndValue, ValueOnly], [testCase.type])
          sinon.assert.calledOnceWithExactly(report, { file: relFile, line, column, ident, data: testCase.id })
        })
      })
    })

    it('should not fail with an malformed secrets', () => {
      assert.doesNotThrow(() => hardcodedSecretAnalyzer.analyze(undefined))
      assert.doesNotThrow(() => hardcodedSecretAnalyzer.analyze({ file: undefined }))
      assert.doesNotThrow(() => hardcodedSecretAnalyzer.analyze({ file, literals: undefined }))
      assert.doesNotThrow(() => hardcodedSecretAnalyzer.analyze({ file, literals: [{ value: undefined }] }))
      assert.doesNotThrow(() => hardcodedSecretAnalyzer.analyze({ file, literals: [{ value: 'test' }] }))
    })

    it('should not report secrets in line 0', () => {
      hardcodedSecretAnalyzer.analyze({
        file,
        literals: [{ value: 'test', line: 0 }],
      })

      sinon.assert.notCalled(report)
    })
  })

  describe('full feature', () => {
    const filename = 'hardcoded-secret-functions'
    const functionsPath = path.join(os.tmpdir(), filename)
    let rewriter

    before(() => {
      fs.copyFileSync(path.join(__dirname, 'resources', `${filename}.js`), functionsPath)
    })

    after(() => {
      fs.unlinkSync(functionsPath)
    })

    describe('with iast enabled', () => {
      beforeEach(() => {
        return agent.load(undefined, undefined, { flushInterval: 1 })
      })

      beforeEach(() => {
        const tracer = require('../../../../')
        const config = getConfigFresh({
          experimental: {
            iast: {
              enabled: true,
              requestSampling: 100,
            },
          },
        })
        iast.enable(config, tracer)
        rewriter = require('../../../../src/appsec/iast/taint-tracking/rewriter')
        rewriter.enable(config)
      })

      afterEach(() => {
        iast.disable()
        rewriter.disable()
        vulnerabilityReporter.clearCache()
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should detect vulnerability', (done) => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(
              JSON.parse(traces[0][0].meta['_dd.iast.json']),
              { vulnerabilities: [{ type: 'HARDCODED_SECRET' }] }
            )
          })
          .then(done)
          .catch(done)

        require(functionsPath)
      })
    })
  })
})
