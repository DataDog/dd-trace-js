'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('template-injection-analyzer with handlebars', () => {
  withVersions('handlebars', 'handlebars', version => {
    let lib, badSource, goodSource
    before(() => {
      lib = require(`../../../../../../versions/handlebars@${version}`).get()
      badSource = `
          {{#with "s" as |string|}}
            {{#with "e"}}
              {{#with split as |conslist|}}
                {{this.pop}}
                {{this.push (lookup string.sub "constructor")}}
                {{this.pop}}
                {{#with string.split as |codelist|}}
                  {{this.pop}}
                  {{this.push "return JSON.stringify(process.env);"}}
                  {{this.pop}}
                  {{#each conslist}}
                    {{#with (string.sub.apply 0 codelist)}}
                      {{this}}
                    {{/with}}
                  {{/each}}
                {{/with}}
              {{/with}}
            {{/with}}
          {{/with}}
          `
      goodSource = '<p>{{name}}</p>'
    })

    describe('compile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const command = newTaintedString(iastContext, badSource, 'param', 'Request')
            const template = lib.compile(command)
            template()
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            const template = lib.compile(goodSource)
            template()
          }, 'TEMPLATE_INJECTION')
        })
    })

    describe('precompile', () => {
      prepareTestServerForIast('template injection analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const command = newTaintedString(iastContext, badSource, 'param', 'Request')
            lib.precompile(command)
          }, 'TEMPLATE_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            lib.precompile(goodSource)
          }, 'TEMPLATE_INJECTION')
        })
    })
  })
})
