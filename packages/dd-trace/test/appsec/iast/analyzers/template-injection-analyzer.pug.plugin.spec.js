'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('template-injection-analyzer with pug', () => {
  withVersions('pug', 'pug', version => {
    let lib, source
    before(() => {
      lib = require(`../../../../../../versions/pug@${version}`).get()
      source = 'string of pug'
    })

    describe('compile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compile(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            const template = lib.compile(source)
            template()
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('compileClient', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClient(template)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            lib.compileClient(source)
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('compileClientWithDependenciesTracked', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const template = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClientWithDependenciesTracked(template, {})
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            lib.compileClient(source)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
