'use strict'

const { loadRules, clearAllRules, updateWafFromRC } = require('../../src/appsec/rule_manager')
const Config = require('../../src/config')
const { ACKNOWLEDGED } = require('../../src/appsec/remote_config/apply_states')

const rules = require('../../src/appsec/recommended.json')
const waf = require('../../src/appsec/waf')

describe('AppSec Rule Manager', () => {
  let config

  beforeEach(() => {
    clearAllRules()
    config = new Config()

    sinon.stub(waf, 'init').callThrough()
    sinon.stub(waf, 'destroy').callThrough()
    sinon.stub(waf, 'update').callThrough()
  })

  afterEach(() => {
    sinon.restore()
    clearAllRules()
  })

  describe('loadRules', () => {
    it('should call waf init with proper params', () => {
      loadRules(config.appsec)

      expect(waf.init).to.have.been.calledOnceWithExactly(rules, config.appsec)
    })

    it('should throw if null/undefined are passed', () => {
      // TODO: fix the exception thrown in the waf or catch it in rule_manager?
      config.appsec.rules = './not/existing/file.json'
      expect(() => { loadRules(config.appsec) }).to.throw()

      config.appsec.rules = './bad-formatted-rules.json'
      expect(() => { loadRules(config.appsec) }).to.throw()
    })
  })

  describe('clearAllRules', () => {
    it('should call clear method on all applied rules', () => {
      loadRules(config.appsec)
      expect(waf.init).to.have.been.calledOnce

      clearAllRules()
      expect(waf.destroy).to.have.been.calledOnce
    })
  })

  describe('updateWafFromRC', () => {
    describe('ASM_DATA', () => {
      it('should call update with modified rules', () => {
        const rulesData = {
          rules_data: [{
            data: [
              { value: '1.2.3.4' }
            ],
            id: 'blocked_ips',
            type: 'data_with_expiration'
          }]
        }

        const toModify = [{
          product: 'ASM_DATA',
          id: '1',
          file: rulesData
        }]

        updateWafFromRC({ toUnapply: [], toApply: [], toModify })
        expect(waf.update).to.have.been.calledOnceWithExactly(rulesData)
      })

      it('should apply/modify the last rule with same id', () => {
        const rulesDataFirst = {
          rules_data: [{
            data: [
              { value: '1.2.3.4' }
            ],
            id: 'blocked_ips',
            type: 'data_with_expiration'
          }]
        }

        const rulesDataSecond = {
          rules_data: [{
            data: [
              { value: '4.3.2.1' }
            ],
            id: 'blocked_ips',
            type: 'data_with_expiration'
          }]
        }

        const toModify = [
          {
            product: 'ASM_DATA',
            id: '1',
            file: rulesDataFirst
          },
          {
            product: 'ASM_DATA',
            id: '1',
            file: rulesDataSecond
          }
        ]

        const expectedPayload = {
          rules_data: [
            { data: [{ value: '4.3.2.1' }], id: 'blocked_ips', type: 'data_with_expiration' }
          ]
        }

        updateWafFromRC({ toUnapply: [], toApply: [], toModify })
        expect(waf.update).to.have.been.calledOnce
        expect(waf.update).calledWithExactly(expectedPayload)
      })

      it('should merge all apply/modify rules', () => {
        const toModify = [
          {
            product: 'ASM_DATA',
            id: '1',
            file: {
              rules_data: [{
                data: [
                  { value: '1.2.3.4' }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          },
          {
            product: 'ASM_DATA',
            id: '2',
            file: {
              rules_data: [{
                data: [
                  { value: '4.3.2.1' }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          }
        ]

        const expectedPayload = {
          rules_data: [
            { data: [{ value: '1.2.3.4' }, { value: '4.3.2.1' }], id: 'blocked_ips', type: 'data_with_expiration' }
          ]
        }

        updateWafFromRC({ toUnapply: [], toApply: [], toModify })
        expect(waf.update).to.have.been.calledOnce
        expect(waf.update).calledWithExactly(expectedPayload)
      })

      it('should merge all apply/modify and unapply rules', () => {
        const toModify = [
          {
            product: 'ASM_DATA',
            id: '1',
            file: {
              rules_data: [{
                data: [
                  { value: '4.3.2.1' }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          },
          {
            product: 'ASM_DATA',
            id: '2',
            file: {
              rules_data: [{
                data: [
                  { value: '4.3.2.1' }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          }
        ]

        const toUnapply = [
          {
            product: 'ASM_DATA',
            id: '2',
            file: {
              rules_data: [{
                data: [
                  { value: '1.2.3.4' }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          }
        ]

        const expectedPayload = {
          rules_data: [
            { data: [{ value: '4.3.2.1' }], id: 'blocked_ips', type: 'data_with_expiration' }
          ]
        }

        updateWafFromRC({ toUnapply, toApply: [], toModify })
        expect(waf.update).to.have.been.calledOnce
        expect(waf.update).calledWithExactly(expectedPayload)
      })

      it('should merge all apply/modify rules with different expiration', () => {
        // TODO: use case from previous tests, not sure if this can happen.
        const toApply = [
          {
            product: 'ASM_DATA',
            id: '1',
            file: {
              rules_data: [{
                data: [
                  { value: '1.2.3.4', expiration: 200 }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          },
          {
            product: 'ASM_DATA',
            id: '2',
            file: {
              rules_data: [{
                data: [
                  { value: '1.2.3.4', expiration: 100 }
                ],
                id: 'blocked_ips',
                type: 'data_with_expiration'
              }]
            }
          }
        ]

        const expectedPayload = {
          rules_data: [
            { data: [{ value: '1.2.3.4', expiration: 200 }], id: 'blocked_ips', type: 'data_with_expiration' }
          ]
        }

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })
        expect(waf.update).to.have.been.calledOnce
        expect(waf.update).calledWithExactly(expectedPayload)
      })
    })

    describe('ASM_DD', () => {
      beforeEach(() => {
        loadRules(config.appsec)
      })

      it('should apply new rules', () => {
        const testRules = {
          version: '2.2',
          metadata: { rules_version: '1.5.0' },
          rules: [{
            id: 'test-id',
            name: 'test-name',
            tags: {
              type: 'security_scanner',
              category: 'attack_attempt',
              confidence: '1'
            },
            conditions: []
          }],
          processors: [{
            id: 'test-processor-id',
            generator: 'test-generator',
            evaluate: false,
            output: true
          }],
          scanners: [{
            id: 'test-scanner-id',
            name: 'Test name',
            key: {
              operator: 'match_regex',
              parameters: {
                regex: 'test-regex'
              }
            },
            value: {
              operator: 'match_regex',
              parameters: {
                regex: 'test-regex-2'
              }
            },
            tags: {
              type: 'card',
              card_type: 'test',
              category: 'payment'
            }
          }]
        }

        const toApply = [
          {
            product: 'ASM_DD',
            id: '1',
            file: testRules
          }
        ]

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })
        expect(waf.update).to.have.been.calledOnceWithExactly(testRules)
      })

      it('should maintain previously added exclusions and rules_overrides', () => {
        const asm = {
          exclusions: [{
            ekey: 'eValue'
          }]
        }
        const testRules = {
          version: '2.2',
          metadata: { rules_version: '1.5.0' },
          rules: [{
            id: 'test-id',
            name: 'test-name',
            tags: {
              type: 'security_scanner',
              category: 'attack_attempt',
              confidence: '1'
            },
            conditions: []
          }],
          processors: [{
            id: 'test-processor-id',
            generator: 'test-generator',
            evaluate: false,
            output: true
          }],
          scanners: [{
            id: 'test-scanner-id',
            name: 'Test name',
            key: {
              operator: 'match_regex',
              parameters: {
                regex: 'test-regex'
              }
            },
            value: {
              operator: 'match_regex',
              parameters: {
                regex: 'test-regex-2'
              }
            },
            tags: {
              type: 'card',
              card_type: 'test',
              category: 'payment'
            }
          }]
        }

        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          },
          {
            product: 'ASM_DD',
            id: '2',
            file: testRules
          }
        ]

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })
        expect(waf.update).to.have.been.calledWithExactly({ ...testRules, ...asm })
      })

      it('should support hotswapping ruleset in same batch', () => {
        const rules1 = {
          product: 'ASM_DD',
          id: 'rules1',
          file: {
            version: '2.2',
            metadata: { rules_version: '1.5.0' },
            rules: [{
              id: 'test-id',
              name: 'test-name',
              tags: {
                type: 'security_scanner',
                category: 'attack_attempt',
                confidence: '1'
              },
              conditions: [
                {
                  parameters: {
                    inputs: [
                      { address: 'http.test' }
                    ],
                    data: 'blocked_ips'
                  },
                  operator: 'ip_match'
                }
              ]
            }]
          }
        }

        const rules2 = {
          product: 'ASM_DD',
          id: 'rules2',
          file: {
            version: '2.2',
            metadata: { rules_version: '1.5.0' },
            rules: [{
              id: 'test-id',
              name: 'test-name',
              tags: {
                type: 'security_scanner',
                category: 'attack_attempt',
                confidence: '1'
              },
              conditions: [
                {
                  parameters: {
                    inputs: [
                      { address: 'http.test' }
                    ],
                    data: 'blocked_ips'
                  },
                  operator: 'ip_match'
                }
              ]
            }]
          }
        }

        updateWafFromRC({ toUnapply: [], toApply: [rules1], toModify: [] })

        updateWafFromRC({ toUnapply: [rules1], toApply: [rules2], toModify: [] })

        expect(rules1.apply_state).to.equal(ACKNOWLEDGED)
        expect(rules1.apply_error).to.equal(undefined)
        expect(rules2.apply_state).to.equal(ACKNOWLEDGED)
        expect(rules2.apply_error).to.equal(undefined)
      })
    })

    describe('ASM', () => {
      it('should apply both rules_override and exclusions', () => {
        const asm = {
          exclusions: [{
            ekey: 'eValue'
          }],
          rules_override: [{
            roKey: 'roValue'
          }],
          custom_rules: [{
            piKey: 'piValue'
          }]
        }

        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          }
        ]

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })

        expect(waf.update).to.have.been.calledOnceWithExactly(asm)
      })

      it('should apply blocking actions', () => {
        const asm = {
          actions: [
            {
              id: 'block',
              otherParam: 'other'
            },
            {
              id: 'otherId',
              moreParams: 'more'
            }
          ]
        }

        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          }
        ]

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })
        expect(waf.update).to.have.been.calledOnceWithExactly(asm)
      })

      it('should unapply blocking actions', () => {
        const asm = {
          actions: [
            {
              id: 'block',
              otherParam: 'other'
            },
            {
              id: 'otherId',
              moreParams: 'more'
            }
          ]
        }
        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          }
        ]
        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })

        const toUnapply = [
          {
            product: 'ASM',
            id: '1'
          }
        ]

        updateWafFromRC({ toUnapply, toApply: [], toModify: [] })

        expect(waf.update).to.have.been.calledOnceWithExactly(asm)
      })

      it('should ignore other properties', () => {
        const asm = {
          exclusions: [{
            ekey: 'eValue'
          }],
          rules_override: [{
            roKey: 'roValue'
          }],
          not_supported: [{
            nsKey: 'nsValue'
          }]
        }

        const toApply = [
          {
            product: 'ASM',
            id: '1',
            file: asm
          }
        ]

        updateWafFromRC({ toUnapply: [], toApply, toModify: [] })

        expect(waf.update).to.have.been.calledOnceWithExactly({
          exclusions: asm.exclusions,
          rules_override: asm.rules_override
        })
      })
    })
  })
})
