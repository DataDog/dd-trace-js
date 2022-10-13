'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const log = require('../../dd-trace/src/log')
const GraphQLExecutePlugin = require('./execute')
const GraphQLParsePlugin = require('./parse')
const GraphQLValidatePlugin = require('./validate')
const GraphQLResolvePlugin = require('./resolve')

class GraphQLPlugin extends CompositePlugin {
  static get name () { return 'graphql' }
  static get plugins () {
    return {
      execute: GraphQLExecutePlugin,
      parse: GraphQLParsePlugin,
      validate: GraphQLValidatePlugin,
      resolve: GraphQLResolvePlugin
    }
  }

  configure (config) {
    return super.configure(validateConfig(config))
  }
}

// config validator helpers

function validateConfig (config) {
  return Object.assign({}, config, {
    depth: getDepth(config),
    variables: getVariablesFilter(config),
    collapse: config.collapse === undefined || !!config.collapse,
    hooks: getHooks(config)
  })
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
  } else if (config.variables instanceof Array) {
    return variables => pick(variables, config.variables)
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be an array or function.')
  }
  return null
}

function getHooks (config) {
  const noop = () => { }
  const execute = (config.hooks && config.hooks.execute) || noop
  const parse = (config.hooks && config.hooks.parse) || noop
  const validate = (config.hooks && config.hooks.validate) || noop

  return { execute, parse, validate }
}

// non-lodash pick

function pick (obj, selectors) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => selectors.includes(key)))
}

module.exports = GraphQLPlugin
