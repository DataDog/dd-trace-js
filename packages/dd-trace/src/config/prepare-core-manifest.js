'use strict'

const applyMajorOverrides = require('./major-overrides')

const nativeTransforms = new Set(['sampleRate', 'toLowerCase', 'toUpperCase'])

/**
 * @typedef {import('./helper').SupportedConfigurationsJson} SupportedConfigurationsJson
 * @typedef {import('./helper').SupportedConfigurationEntry} SupportedConfigurationEntry
 * @typedef {{
 *   preserveEmptyItems?: boolean,
 *   mapSyntax?: 'equals_percent_decoded' | 'colon_or_space_separated',
 * }} ParseOptions
 * @typedef {Omit<SupportedConfigurationEntry, 'allowed'> & {
 *   aliasOnly?: boolean,
 *   allowed?: { pattern: string, validateDefault: boolean },
 *   parse?: ParseOptions,
 * }} PreparedDefinition
 * @typedef {{
 *   name: string,
 *   input: string,
 *   output: 'host',
 *   slot: number,
 *   transform: string | undefined,
 *   allowed?: string,
 *   validateDefault?: boolean,
 * }} HostTransform
 */

/**
 * @param {string} pattern
 */
function portablePattern (pattern) {
  if (pattern === '.+') {
    return String.raw`[^\r\n\x{2028}\x{2029}]+`
  }
  if (/[^\x20-\x7E]|\\[^d.]|\[\^|\(\?(?!:)|(?<!\\)\./.test(pattern)) {
    return
  }

  // Legacy ECMAScript case folding and \d are ASCII for these patterns.
  return `(?i-u:${pattern})`
}

/**
 * @param {SupportedConfigurationsJson} source A freshly loaded manifest.
 * @param {number} major
 */
function prepareManifest (source, major) {
  const { supportedConfigurations } = source
  applyMajorOverrides(supportedConfigurations, major)

  /** @type {Map<string, HostTransform>} */
  const hostTransforms = new Map()
  const prepared = {}
  for (const [name, entries] of Object.entries(supportedConfigurations)) {
    prepared[name] = entries.map(entry => {
      const { transform: originalTransform, allowed, ...definition } = entry
      let transform = originalTransform === 'iastRequestSampling' ? undefined : originalTransform
      const pattern = allowed && portablePattern(allowed)
      const hostAllowed = allowed && pattern === undefined
      const validateDefault = originalTransform !== undefined
      if (hostAllowed || transform && !nativeTransforms.has(transform)) {
        const hostName = hostAllowed
          ? `node.allowed.${name}`
          : `node.${transform}`
        const bindingName = `${hostName}:${entry.type}`
        if (!hostTransforms.has(bindingName)) {
          /** @type {HostTransform} */
          const binding = { name: hostName, input: entry.type, output: 'host', slot: hostTransforms.size, transform }
          if (hostAllowed) {
            binding.allowed = allowed
            binding.validateDefault = validateDefault
          }
          hostTransforms.set(bindingName, binding)
        }
        transform = hostName
      }

      /** @type {PreparedDefinition} */
      const rule = definition
      if (entry.deprecated && entry.aliases) {
        rule.aliasOnly = true
      }
      if (pattern) {
        rule.allowed = { pattern, validateDefault }
      }
      if (transform) {
        rule.transform = transform
      }
      if (name === 'DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS') {
        rule.parse = { preserveEmptyItems: true }
      } else if (entry.type === 'map' && name.startsWith('OTEL_')) {
        rule.parse = { mapSyntax: 'equals_percent_decoded' }
      } else if (name === 'DD_TAGS') {
        rule.parse = { mapSyntax: 'colon_or_space_separated' }
      }
      return rule
    })
  }

  return { manifest: { ...source, supportedConfigurations: prepared }, hostTransforms: [...hostTransforms.values()] }
}

module.exports = prepareManifest
