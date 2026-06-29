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

function validateConfig (config) {
  return {
    ...config,
    depth: getDepth(config),
    variables: getVariablesFilter(config),
    collapse: getCollapse(config),
    hooks: getHooks(config),
  }
}

function getCollapse (config) {
  // Programmatic `collapse` (via `tracer.use`) takes precedence over the
  // `DD_TRACE_GRAPHQL_COLLAPSE_ENABLED` env var; both default to collapsing on.
  if (config.collapse !== undefined) {
    return !!config.collapse
  }
  return config.DD_TRACE_GRAPHQL_COLLAPSE_ENABLED === undefined || !!config.DD_TRACE_GRAPHQL_COLLAPSE_ENABLED
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
    return variables => pick(variables, config.variables)
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be an array or function.')
  }
  return null
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
