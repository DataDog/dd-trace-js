'use strict'

const rules = require('./extended-data-collection.rules.json')
const RuleManager = require('../../src/appsec/rule_manager')
const Config = require('../../src/config')
const path = require('path')
const WAFManager = require('../../src/appsec/waf/waf_manager')

describe('extended data collection', () => {
  let wafManager
  before(() => {
    const rulesPath = path.join(__dirname, './extended-data-collection.rules.json')
    const config = new Config({ appsec: { enabled: true, rules: rulesPath }})
    RuleManager.loadRules(config.appsec)
    wafManager = new WAFManager(rules, config.appsec)
  })

  it('hello', () => {
    const req = {}
    const wafContext = wafManager.getWAFContext(req)
    // console.log('wafContext', wafContext)
    const data = {
      persistent: {
        'server.request.body': 'collect'
      }
    }
    const result = wafContext.run(data)
    console.log('result', result)
  })
})
