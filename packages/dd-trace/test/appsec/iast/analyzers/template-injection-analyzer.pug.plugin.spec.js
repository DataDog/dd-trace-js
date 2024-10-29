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
            const command = newTaintedString(iastContext, source, 'param', 'Request')
            const template = lib.compile(command)
            template()
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
            const command = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClient(command)
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
            const command = newTaintedString(iastContext, source, 'param', 'Request')
            lib.compileClientWithDependenciesTracked(command, {})
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            lib.compileClient(source)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
