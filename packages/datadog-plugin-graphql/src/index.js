'use strict'

const pick = require('../../datadog-core/src/utils/src/pick')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const log = require('../../dd-trace/src/log')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const GraphQLValidatePlugin = require('./validate')

class GraphQLPlugin extends CompositePlugin {
  static id = 'graphql'
  static get plugins () {
    return {
      execute: GraphQLExecutePlugin,
      parse: GraphQLParsePlugin,
      validate: GraphQLValidatePlugin,
      // resolve plugin is absorbed into execute: per-field data is recorded
      // synchronously in wrapResolve, and all graphql.resolve spans are
      // materialized at execute end.
    }
  }

  /**
   * @override
   */
  configure (config) {
    return super.configure(validateConfig(config))
  }
}

// config validator helpers
//
// `collapse`, `depth`, `variables`, and `errorExtensions` arrive pre-merged on
// `config`: plugin_manager seeds the `DD_TRACE_GRAPHQL_*` env values (already
// parsed to their declared type) as the base and a programmatic
// `tracer.use('graphql', …)` value overrides them. So these helpers only shape
// the merged value — coerce, validate, and turn `variables` into a filter — and
// never read the environment themselves.

function validateConfig (config) {
  return {
    ...config,
    depth: getDepth(config),
    variables: getVariablesFilter(config),
    collapse: config.collapse === undefined || !!config.collapse,
    errorExtensions: getErrorExtensions(config),
    hooks: getHooks(config),
  }
}

function getDepth (config) {
  if (typeof config.depth === 'number') {
    return config.depth
  } else if (config.hasOwnProperty('depth')) {
    log.error('Expected `depth` to be a integer.')
  }
  return -1
}

function getVariablesFilter (config) {
  if (typeof config.variables === 'function') {
    return config.variables
  } else if (Array.isArray(config.variables)) {
    return config.variables.length > 0 ? variables => pick(variables, config.variables) : null
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be an array or function.')
  }
  return null
}

function getErrorExtensions (config) {
  if (Array.isArray(config.errorExtensions)) {
    return config.errorExtensions.length > 0 ? config.errorExtensions : undefined
  } else if (config.hasOwnProperty('errorExtensions')) {
    log.error('Expected `errorExtensions` to be an array.')
  }
}

const noop = () => {}
const noopHooks = { execute: noop, parse: noop, validate: noop, resolve: undefined }

function getHooks ({ hooks }) {
  if (!hooks) return noopHooks
  return {
    execute: hooks.execute ?? noop,
    parse: hooks.parse ?? noop,
    validate: hooks.validate ?? noop,
    // No noop fallback: `resolve` runs per-field (hot path); the plugin
    // gates with `if (this.config.hooks.resolve)` so the absent-hook case
    // skips both the call and the payload-object allocation.
    resolve: hooks.resolve,
  }
}

module.exports = GraphQLPlugin
