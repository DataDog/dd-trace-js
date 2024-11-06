'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

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
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compile(template)
          }, 'TEMPLATE_INJECTION')

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
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.precompile(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            lib.precompile(source)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
