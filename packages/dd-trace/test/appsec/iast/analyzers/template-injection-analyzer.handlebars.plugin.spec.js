'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const { withVersions } = require('../../../setup/mocha')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../../../../src/appsec/iast/taint-tracking/source-types')

describe('template-injection-analyzer with handlebars', () => {
  withVersions('handlebars', 'handlebars', version => {
    let source
    before(() => {
      source = '<p>{{name}}</p>'
    })

    describe('compile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/handlebars@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compile(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)
            lib.compile(template)
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.compile(source)
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('precompile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/handlebars@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.precompile(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)
            lib.precompile(template)
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.precompile(source)
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('registerPartial', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/handlebars@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const partial = newTaintedString(iastContext, source, 'param', 'Request')

            lib.registerPartial('vulnerablePartial', partial)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const partial = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

            lib.registerPartial('vulnerablePartial', partial)
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.registerPartial('vulnerablePartial', source)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
