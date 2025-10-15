'use strict'

const { prepareTestServerForIast } = require('../utils')
const { withVersions } = require('../../../setup/mocha')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

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
            const store = storage('legacy').getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, obj, 'query', 'Request')
            lib.unserialize(str)
          }, 'UNTRUSTED_DESERIALIZATION')

          testThatRequestHasNoVulnerability(() => {
            lib.unserialize(obj)
          }, 'UNTRUSTED_DESERIALIZATION')
        })
    })
  })
})
