'use strict'

/**
 * @typedef {object} WafConfig
 * @property {number} wafTimeout
 * @property {number} rateLimit
 * @property {RegExp | undefined} obfuscatorKeyRegex
 * @property {RegExp | undefined} obfuscatorValueRegex
 */

/**
 * @typedef {object} DDWAFDiagnostics
 * @property {string | undefined} ruleset_version
 * @property {unknown} [rules]
 */

/**
 * @typedef {object} DDWAF
 * @property {DDWAFDiagnostics} diagnostics
 * @property {Set<string>} knownAddresses
 * @property {string[]} [configPaths]
 * @property {(rules: object, path: string) => boolean} createOrUpdateConfig
 * @property {(path: string) => void} removeConfig
 * @property {() => void} dispose
 * @property {() => DDWAFContext} createContext
 */

/**
 * @typedef {object} DDWAFContext
 * @property {boolean} [disposed]
 * @property {(payload: object, timeout: number) => object} run
 * @property {() => void} dispose
 */

/** @typedef {import('./waf_context_wrapper')} WAFContextWrapperCtor */
/** @typedef {InstanceType<WAFContextWrapperCtor>} WAFContextWrapperInstance */

/**
 * Thin manager around native DDWAF providing lifecycle and per-request context handling.
 */

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()

class WAFManager {
  /** @type {string} */
  static defaultWafConfigPath = 'datadog/00/ASM_DD/default/config'

  /**
   * @param {object} rules
   * @param {WafConfig} config
   */
  constructor (rules, config) {
    /** @type {WafConfig} */
    this.config = config
    /** @type {number} */
    this.wafTimeout = config.wafTimeout
    /** @type {DDWAF} */
    this.ddwaf = this._loadDDWAF(rules)
    /** @type {string | undefined} */
    this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    /** @type {object} */
    this.defaultRules = rules

    Reporter.reportWafInit(this.ddwafVersion, this.rulesVersion, this.ddwaf.diagnostics.rules, true)
  }

  /**
   * @param {object} rules
   * @returns {DDWAF}
   */
  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')
      /** @type {string} */
      this.ddwafVersion = DDWAF.version()

      const { obfuscatorKeyRegex, obfuscatorValueRegex } = this.config
      return new DDWAF(rules, WAFManager.defaultWafConfigPath, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      this.ddwafVersion = this.ddwafVersion || 'unknown'
      Reporter.reportWafInit(this.ddwafVersion, 'unknown')

      log.error('[ASM] AppSec could not load native package. In-app WAF features will not be available.')

      throw err
    }
  }

  /**
   * @param {object} req
   * @returns {WAFContextWrapperInstance}
   */
  getWAFContext (req) {
    let wafContext = contexts.get(req)

    if (!wafContext) {
      wafContext = new WAFContextWrapper(
        this.ddwaf.createContext(),
        this.wafTimeout,
        this.ddwafVersion,
        this.rulesVersion,
        this.ddwaf.knownAddresses
      )
      contexts.set(req, wafContext)
    }

    return wafContext
  }

  /** @returns {void} */
  setRulesVersion () {
    if (this.ddwaf.diagnostics.ruleset_version) {
      this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    }
  }

  /** @returns {void} */
  setAsmDdFallbackConfig () {
    if (!this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
      this.updateConfig(WAFManager.defaultWafConfigPath, this.defaultRules)
    }
  }

  /**
   * @param {string} path
   * @param {object} rules
   * @returns {boolean}
   */
  updateConfig (path, rules) {
    const updateResult = this.ddwaf.createOrUpdateConfig(rules, path)
    this.setRulesVersion()
    return updateResult
  }

  /**
   * @param {string} path
   * @returns {void}
   */
  removeConfig (path) {
    this.ddwaf.removeConfig(path)
    this.setRulesVersion()
  }

  /** @returns {void} */
  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

module.exports = WAFManager
