'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../../../../src/appsec/iast/taint-tracking/source-types')

describe('untrusted-deserialization-analyzer with node-serialize', () => {
  withVersions('node-serialize', 'node-serialize', version => {
    let obj
    before(() => {
      obj = JSON.stringify({ name: 'example' })
    })

    describe('unserialize', () => {
      prepareTestServerForIast('untrusted deserialization analyzer',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          let lib
          beforeEach(() => {
            lib = require(`../../../../../../versions/node-serialize@${version}`).get()
          })

          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, obj, 'query', 'Request')
            lib.unserialize(str)
          }, 'UNTRUSTED_DESERIALIZATION')

          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, obj, 'query', SQL_ROW_VALUE)
            lib.unserialize(str)
          }, 'UNTRUSTED_DESERIALIZATION', undefined, undefined, undefined,
          'Should detect UNTRUSTED_DESERIALIZATION vulnerability with DB source')

          testThatRequestHasNoVulnerability(() => {
            lib.unserialize(obj)
          }, 'UNTRUSTED_DESERIALIZATION')
        })
    })
  })
})
