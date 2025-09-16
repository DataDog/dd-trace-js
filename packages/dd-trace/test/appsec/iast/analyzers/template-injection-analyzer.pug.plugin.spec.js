'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const { withVersions } = require('../../../setup/mocha')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../../../../src/appsec/iast/taint-tracking/source-types')

describe('template-injection-analyzer with pug', () => {
  withVersions('pug', 'pug', version => {
    let source
    before(() => {
      source = 'string of pug'
    })

    describe('compile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/pug@${version}`).get()
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
            const template = lib.compile(source)
            template()
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('compileClient', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/pug@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClient(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)
            lib.compileClient(template)
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.compileClient(source)
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('compileClientWithDependenciesTracked', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/pug@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClientWithDependenciesTracked(template, {})
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)
            lib.compileClientWithDependenciesTracked(template, {})
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.compileClient(source)
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('render', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/pug@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, source, 'param', 'Request')
            lib.render(str)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasVulnerability(() => {
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)
            lib.render(str)
          }, 'TEMPLATE_INJECTION', undefined, undefined, undefined,
          'Should detect TEMPLATE_INJECTION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.render(source)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
