'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ApolloGatewayPlugin = require('./gateway')

class ApolloPlugin extends CompositePlugin {
  static id = 'apollo'
  static get plugins () {
    return {
      gateway: ApolloGatewayPlugin,
    }
  }

  /**
   * @override
   */
  configure (config) {
    return super.configure(validateConfig(config))
  }
}

const noop = () => {}

function validateConfig (config) {
  return {
    ...config,
    hooks: getHooks(config),
  }
}

function getHooks (config) {
  const hooks = config?.hooks
  const request = hooks?.request ?? noop
  const validate = hooks?.validate ?? noop
  const plan = hooks?.plan ?? noop
  const execute = hooks?.execute ?? noop
  const fetch = hooks?.fetch ?? noop
  const postprocessing = hooks?.postprocessing ?? noop

  return { request, validate, plan, execute, fetch, postprocessing }
}

module.exports = ApolloPlugin
