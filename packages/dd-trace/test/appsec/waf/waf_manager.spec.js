'use strict'

const proxyquire = require('proxyquire')

describe('WAFManager', () => {
  let WAFManager, WAFContextWrapper, DDWAF
  const knownAddresses = new Set()

  beforeEach(() => {
    DDWAF = sinon.stub()
    DDWAF.version = sinon.stub()
    DDWAF.prototype.knownAddresses = knownAddresses
    DDWAF.prototype.diagnostics = {}
    DDWAF.prototype.createContext = sinon.stub()
    DDWAF.prototype.createOrUpdateConfig = sinon.stub()
    DDWAF.prototype.removeConfig = sinon.stub()
    DDWAF.prototype.configPaths = []

    WAFContextWrapper = sinon.stub()
    WAFManager = proxyquire('../../../src/appsec/waf/waf_manager', {
      './waf_context_wrapper': WAFContextWrapper,
      '@datadog/native-appsec': { DDWAF }
    })
  })

  describe('getWAFContext', () => {
    it('should construct WAFContextWrapper with knownAddresses', () => {
      const wafManager = new WAFManager({}, {})

      wafManager.getWAFContext({})

      const any = sinon.match.any
      sinon.assert.calledOnceWithMatch(WAFContextWrapper, any, any, any, any, knownAddresses)
    })
  })

  describe('WAF configurations handling', () => {
    let wafManager

    const DEFAULT_RULES = {
      version: '2.2',
      metadata: {
        rules_version: '1.14.2'
      },
      rules: [
        {
          id: 'blk-001-001',
          name: 'Block IP Addresses',
          tags: {
            type: 'block_ip',
            category: 'security_response',
            module: 'network-acl'
          },
          conditions: [
            {
              parameters: {
                inputs: [
                  {
                    address: 'http.client_ip'
                  }
                ],
                data: 'blocked_ips'
              },
              operator: 'ip_match'
            }
          ],
          transformers: [],
          on_match: [
            'block'
          ]
        }
      ]
    }

    const ASM_CONFIG = {
      rules_override: [],
      actions: [],
      exclusions: [],
      custom_rules: []
    }

    const ASM_DATA_CONFIG = {
      rules_data: [
        {
          data: [
            {
              expiration: 1661848350,
              value: '188.243.182.156'
            },
            {
              expiration: 1661848350,
              value: '51.222.158.205'
            }
          ],
          id: 'blocked_ips',
          type: 'ip_with_expiration'
        }
      ]
    }

    const ASM_DD_CONFIG = {
      version: '2.2',
      metadata: {
        rules_version: '1.42.11'
      },
      rules: []
    }

    beforeEach(() => {
      wafManager = new WAFManager(DEFAULT_RULES, {})
    })

    afterEach(() => {
      sinon.restore()
    })

    describe('update config', () => {
      it('should update WAF config - ASM / ASM_DATA', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        wafManager.update(
          'ASM',
          ASM_CONFIG,
          'datadog/00/ASM/test/update_config'
        )

        wafManager.update(
          'ASM_DATA',
          ASM_DATA_CONFIG,
          'datadog/00/ASM_DATA/test/update_config'
        )

        sinon.assert.calledWithExactly(
          DDWAF.prototype.createOrUpdateConfig.getCall(0),
          ASM_CONFIG,
          'datadog/00/ASM/test/update_config'
        )
        sinon.assert.calledWithExactly(
          DDWAF.prototype.createOrUpdateConfig.getCall(1),
          ASM_DATA_CONFIG,
          'datadog/00/ASM_DATA/test/update_config'
        )
      })

      it('should remove default rules on ASM_DD update', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        wafManager.update('ASM_DD', ASM_DD_CONFIG, 'datadog/00/ASM_DD/test/update_config')

        sinon.assert.calledOnceWithExactly(
          DDWAF.prototype.removeConfig,
          'datadog/00/ASM_DD/default/config'
        )
        sinon.assert.calledOnceWithExactly(
          DDWAF.prototype.createOrUpdateConfig,
          ASM_DD_CONFIG,
          'datadog/00/ASM_DD/test/update_config'
        )
      })

      it('should apply default rules when no ASM config is present after config update fail', () => {
        DDWAF.prototype.configPaths = []
        DDWAF.prototype.createOrUpdateConfig.returns(false)

        wafManager.update('ASM_DD', ASM_DD_CONFIG, 'datadog/00/ASM_DD/test/update_config')

        sinon.assert.calledWithExactly(
          DDWAF.prototype.createOrUpdateConfig.getCall(1),
          DEFAULT_RULES,
          'datadog/00/ASM_DD/default/config'
        )
      })
    })

    describe('remove config', () => {
      it('should remove WAF config', () => {
        DDWAF.prototype.configPaths = ['datadog/00/ASM_DD/default/config']

        wafManager.remove('path/to/remove')

        sinon.assert.calledOnceWithExactly(DDWAF.prototype.removeConfig, 'path/to/remove')
      })

      it('should apply default rules when no ASM config is present after config removal', () => {
        DDWAF.prototype.configPaths = []

        wafManager.remove('path/to/remove')

        sinon.assert.calledOnceWithExactly(
          DDWAF.prototype.createOrUpdateConfig,
          DEFAULT_RULES,
          'datadog/00/ASM_DD/default/config'
        )
      })
    })
  })
})
