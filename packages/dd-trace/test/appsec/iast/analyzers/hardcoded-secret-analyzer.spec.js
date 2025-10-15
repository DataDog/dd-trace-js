'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const agent = require('../../../plugins/agent')
const Config = require('../../../../src/config')

const { NameAndValue, ValueOnly } = require('../../../../src/appsec/iast/analyzers/hardcoded-rule-type')
const hardcodedSecretAnalyzer = require('../../../../src/appsec/iast/analyzers/hardcoded-secret-analyzer')
const { suite } = require('./resources/hardcoded-secrets-suite.json')
const iast = require('../../../../src/appsec/iast')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

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
        it(`should match rule ${testCase.id} with #${sampleIndex + 1} value ${sample[0]}...`, () => {
          const value = sample.join('')
          const ident = testCase.type === NameAndValue ? value.split(' = ')[0] : undefined

          hardcodedSecretAnalyzer.analyze({
            file,
            literals: [{
              value,
              locations: [{
                line,
                column,
                ident
              }]
            }]
          })

          expect([NameAndValue, ValueOnly]).to.be.include(testCase.type)
          expect(report).to.have.been.calledOnceWithExactly({ file: relFile, line, column, ident, data: testCase.id })
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

      expect(report).not.to.have.been.called
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
        const config = new Config({
          experimental: {
            iast: {
              enabled: true,
              requestSampling: 100
            }
          }
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
            expect(traces[0][0].meta['_dd.iast.json']).to.include('"HARDCODED_SECRET"')
          })
          .then(done)
          .catch(done)

        require(functionsPath)
      })
    })
  })
})
