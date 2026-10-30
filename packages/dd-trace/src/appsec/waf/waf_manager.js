'use strict'

const { isDeepStrictEqual } = require('node:util')

const log = require('../../log')
const Reporter = require('../reporter')
const WAFContextWrapper = require('./waf_context_wrapper')

const contexts = new WeakMap()
const resolverSafeConfigKeys = new Set([
  'actions', 'metadata', 'rules_data', 'rules_override', 'exclusions', 'exclusion_data',
])
const resolverSafeRuleKeys = new Set([
  'id', 'name', 'tags', 'on_match', 'enabled', 'min_version', 'max_version', 'conditions', 'transformers',
])
const stringOperators = new Set(['match_regex', 'phrase_match', 'is_sqli', 'is_xss'])
const valueTransformers = new Set([
  'values_only', 'lowercase', 'remove_nulls', 'compress_whitespace', 'normalize_path', 'normalize_path_win',
  'url_decode', 'url_decode_iis', 'css_decode', 'js_decode', 'html_entity_decode', 'base64_decode',
  'base64url_decode', 'base64_encode', 'shell_unescape', 'url_basename', 'url_path', 'url_querystring',
  'remove_comments', 'unicode_normalize', 'removeNulls', 'compressWhiteSpace', 'normalizePath',
  'normalizePathWin', 'urlDecode', 'urlDecodeUni', 'cssDecode', 'jsDecode', 'htmlEntityDecode',
  'base64Decode', 'base64Encode', 'cmdLine', '_sqr_basename', '_sqr_filename', '_sqr_querystring', 'removeComments',
])
const conditionKeys = new Set(['operator', 'parameters'])
const parameterKeys = new Set(['inputs', 'regex', 'options', 'list', 'data'])
const inputKeys = new Set(['address', 'key_path', 'transformers'])
let bundledRules

/**
 * @typedef {object} WAFManagerConfig
 * @property {number} DD_APPSEC_WAF_TIMEOUT - Maximum time in microseconds for WAF execution
 * @property {string} DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP - Regex to redact sensitive data by key
 * @property {string} DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP - Regex to redact sensitive data by value
 */

class WAFManager {
  static defaultWafConfigPath = 'datadog/00/ASM_DD/default/config'

  #inspectEmptyGraphqlResolvers = new Set()
  #knownAddresses
  #skipEmptyGraphqlResolvers

  /**
   * @param {object} rules
   * @param {WAFManagerConfig} config
   */
  constructor (rules, config) {
    this.config = config
    this.wafTimeout = config.DD_APPSEC_WAF_TIMEOUT
    this.ddwaf = this._loadDDWAF(rules)
    this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    this.defaultRules = rules
    if (!canSkipEmptyGraphqlResolvers(rules)) {
      this.#inspectEmptyGraphqlResolvers.add(WAFManager.defaultWafConfigPath)
    }
    this.#knownAddresses = this.ddwaf.knownAddresses
    this.#skipEmptyGraphqlResolvers = this.#inspectEmptyGraphqlResolvers.size === 0

    Reporter.reportWafInit(this.ddwafVersion, this.rulesVersion, this.ddwaf.diagnostics.rules, true)
  }

  _loadDDWAF (rules) {
    try {
      // require in `try/catch` because this can throw at require time
      const { DDWAF } = require('@datadog/native-appsec')
      this.ddwafVersion = DDWAF.version()

      const {
        DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP: obfuscatorKeyRegex,
        DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP: obfuscatorValueRegex,
      } = this.config
      return new DDWAF(rules, WAFManager.defaultWafConfigPath, { obfuscatorKeyRegex, obfuscatorValueRegex })
    } catch (err) {
      this.ddwafVersion ||= 'unknown'
      Reporter.reportWafInit(this.ddwafVersion, 'unknown')

      log.error('[ASM] AppSec could not load native package. In-app WAF features will not be available.', err)

      throw err
    }
  }

  getWAFContext (req) {
    let wafContext = contexts.get(req)

    if (!wafContext) {
      wafContext = new WAFContextWrapper(
        this.ddwaf.createContext(),
        this.wafTimeout,
        this.ddwafVersion,
        this.rulesVersion,
        this.#knownAddresses,
        this.#skipEmptyGraphqlResolvers
      )
      contexts.set(req, wafContext)
    }

    return wafContext
  }

  setRulesVersion () {
    if (this.ddwaf.diagnostics.ruleset_version) {
      this.rulesVersion = this.ddwaf.diagnostics.ruleset_version
    }
  }

  setAsmDdFallbackConfig () {
    if (!this.ddwaf.configPaths.some(cp => cp.includes('ASM_DD'))) {
      this.updateConfig(WAFManager.defaultWafConfigPath, this.defaultRules)
    }
  }

  updateConfig (path, rules) {
    const skipEmptyResolvers = canSkipEmptyGraphqlResolvers(rules)
    if (!skipEmptyResolvers) this.#inspectEmptyGraphqlResolvers.add(path)

    const updateResult = this.ddwaf.createOrUpdateConfig(rules, path)
    if (updateResult && skipEmptyResolvers) this.#inspectEmptyGraphqlResolvers.delete(path)
    this.#updateGraphqlPolicy()
    this.setRulesVersion()
    return updateResult
  }

  removeConfig (path) {
    if (this.ddwaf.removeConfig(path)) this.#inspectEmptyGraphqlResolvers.delete(path)
    this.#updateGraphqlPolicy()
    this.setRulesVersion()
  }

  #updateGraphqlPolicy () {
    // Native updates can succeed without replacing the instance. A new knownAddresses Set marks publication.
    if (this.#knownAddresses !== this.ddwaf.knownAddresses) {
      this.#knownAddresses = this.ddwaf.knownAddresses
      this.#skipEmptyGraphqlResolvers = this.#inspectEmptyGraphqlResolvers.size === 0
    }
  }

  destroy () {
    if (this.ddwaf) {
      this.ddwaf.dispose()
    }
  }
}

/**
 * @param {object} config
 */
function canSkipEmptyGraphqlResolvers (config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  const bundled = require('../recommended.json')
  for (const key of Object.keys(config)) {
    if (resolverSafeConfigKeys.has(key)) continue
    if (Object.hasOwn(bundled, key) && isDeepStrictEqual(config[key], bundled[key])) continue
    if ((key !== 'rules' && key !== 'custom_rules') || !Array.isArray(config[key])) return false
    if (!bundledRules) {
      bundledRules = new Map()
      for (const rule of bundled.rules) bundledRules.set(rule.id, rule)
    }
    if (!config[key].every(canSkipEmptyRule)) return false
  }
  return true
}

/** @param {object} rule */
function canSkipEmptyRule (rule) {
  if (!hasOnlyKeys(rule, resolverSafeRuleKeys) || !Array.isArray(rule.conditions) || !rule.conditions.length) {
    return false
  }
  const bundled = bundledRules.get(rule.id)
  // Bundled key predicates require "$", which GraphQL names cannot contain. Match predicates, not rule IDs.
  if (bundled && isDeepStrictEqual(rule.conditions, bundled.conditions) &&
      isDeepStrictEqual(rule.transformers, bundled.transformers)) return true
  if (!hasValueTransformers(rule.transformers)) return false

  // These operators only match string leaves. Empty objects and literal Boolean directives have none.
  return rule.conditions.every(condition =>
    hasOnlyKeys(condition, conditionKeys) && stringOperators.has(condition.operator) &&
    hasOnlyKeys(condition.parameters, parameterKeys) && Array.isArray(condition.parameters.inputs) &&
    condition.parameters.inputs.length > 0 && condition.parameters.inputs.every(input =>
      hasOnlyKeys(input, inputKeys) && typeof input.address === 'string' &&
      hasValueTransformers(input.transformers)
    )
  )
}

/** @param {string[] | undefined} transformers */
function hasValueTransformers (transformers) {
  return transformers === undefined ||
    (Array.isArray(transformers) && transformers.every(transformer => valueTransformers.has(transformer)))
}

/**
 * @param {object} value
 * @param {Set<string>} keys
 */
function hasOnlyKeys (value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.has(key))
}

module.exports = WAFManager
