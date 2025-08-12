/* eslint-disable @stylistic/max-len */
'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

const agent = require('../../../plugins/agent')
const Config = require('../../../../src/config')

const hardcodedPasswordAnalyzer = require('../../../../src/appsec/iast/analyzers/hardcoded-password-analyzer')
const iast = require('../../../../src/appsec/iast')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

const ruleId = 'hardcoded-password'
const samples = [
  { ident: 'hashpwd', value: 'hpu0-ig=3o5slyr0rkqszidgxw-bc23tivq8e1-qvt.4191vlwm8ddk.ce64m4q0kga' },
  { ident: 'passphrase', value: '8jqqn=-5k9fnu4ukjzg5ar-=yw4r3_no=cn25zpegfh3.ndid5lp04iknqwvz92npuniksena2sz9w1bipd_g_oyx2ij3xi7cyh8=y.pv_f_gnbupl' },
  { ident: 'password', value: '9z57r5sph9zkgnknefwbnrr5ilqiavsylk9b6qt2a9kg-g=ez=_fwat' },
  { ident: 'passw', value: '8=t6jaeqk0=-e9gspu0e6b91mcmayd2bvq37_nn0yyzzh20qn8t29eg-trn6r4w7.s4r59u160jcgenjb-rpn=1ga' },
  { ident: 'secret', value: 'ha=gcu1r-t.ckeirz9y3jf34zvg7o.qsh.' },
  { ident: 'passkey', value: 'k2urtbthyl=fd6z4wl6r26zlldy3.39ymm.p4l5wu_9mzg30sxx6absd696fgpjub4wu8a0bge-5_dp59xf493oayojzftf4iiavndwixmt-fngxn05naek8' },
  { ident: 'pass', value: 'm-ou4zr=vri2yl-0_ardsza7qbenvy3_2b1h8rsq2_n-.utj9nd3xyvqpg4xl37-nl0nkjwam1avbe9zl' },
  { ident: 'pwd', value: 'e8l=47jevvmz5=trchu6.uu3lwn0fb79bpt=fogw36r1srzb1o1w4f-nhihcni=kncnj9ubs0.2w2tey-b=u9f4-s5l_648p67hf4f2bccv6c4lr3mfcj8a77qv38dlzuhpyb=u' },
  { ident: 'pswd', value: '9rh_n.oooxynt-6._a7ho.2=v-gziqf3wz2vudn916jej_6xaq_1vczboi5rmt5_iuvxxf8oq.ghisjxum' },
  { ident: 'passwd', value: 'vtecj=v6b7-qc1m-s6c=zidew-hw-=c-=4d83icy28-guc3g-vvrimsdf=jml.acy=q7sdwaxh_rl-okx1z48pihg=w4=tc4' }
]

describe('Hardcoded Password Analyzer', () => {
  describe('unit test', () => {
    const relFile = path.join('path', 'to', 'file.js')
    const file = path.join(process.cwd(), relFile)
    const line = 42
    const column = 3

    let report

    beforeEach(() => {
      report = sinon.stub(hardcodedPasswordAnalyzer, '_report')
    })

    afterEach(sinon.restore)

    samples.forEach((sample, sampleIndex) => {
      // sample values are arrays containing the parts of the original token
      it(`should match rule ${ruleId} with #${sampleIndex + 1} value ${sample.ident}...`, () => {
        const ident = sample.ident
        hardcodedPasswordAnalyzer.analyze({
          file,
          literals: [{
            value: sample.value,
            locations: [{
              ident,
              line,
              column
            }]
          }]
        })

        expect(report).to.have.been.calledOnceWithExactly({ file: relFile, line, column, ident, data: ruleId })
      })
    })

    it('should not fail with a malformed secret', () => {
      expect(() => hardcodedPasswordAnalyzer.analyze(undefined)).not.to.throw()
      expect(() => hardcodedPasswordAnalyzer.analyze({ file: undefined })).not.to.throw()
      expect(() => hardcodedPasswordAnalyzer.analyze({ file, literals: undefined })).not.to.throw()
      expect(() => hardcodedPasswordAnalyzer.analyze({ file, literals: [{ value: undefined }] })).not.to.throw()
      expect(() => hardcodedPasswordAnalyzer.analyze({ file, literals: [{ value: 'test' }] })).not.to.throw()
    })

    it('should not report secrets in line 0', () => {
      hardcodedPasswordAnalyzer.analyze({
        file,
        literals: [{ value: 'test', line: 0 }]
      })

      expect(report).not.to.have.been.called
    })

    it('should use ident as evidence', () => {
      report.restore()

      const reportEvidence = sinon.stub(hardcodedPasswordAnalyzer, '_reportEvidence')

      const ident = 'passkey'
      hardcodedPasswordAnalyzer.analyze({
        file,
        literals: [{
          value: 'this_is_a_password',
          locations: [{
            ident,
            line,
            column
          }]
        }]
      })

      const evidence = { value: ident }
      expect(reportEvidence).to.be.calledOnceWithExactly({ file: relFile, line, column, ident, data: ruleId }, undefined, evidence)
    })
  })

  describe('full feature', () => {
    const filename = 'hardcoded-password-functions'
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
            expect(traces[0][0].meta['_dd.iast.json']).to.include('"HARDCODED_PASSWORD"')
            expect(traces[0][0].meta['_dd.iast.json']).to.include('"evidence":{"value":"pswd"}')
          })
          .then(done)
          .catch(done)

        require(functionsPath)
      })
    })
  })
})
