'use strict'

const { readdirSync } = require('node:fs')
const { join } = require('node:path')

const integrationsDir = join(__dirname, 'integrations')

const orchestrion = []
const plugins = {}
const hookEntries = {}

for (const file of readdirSync(integrationsDir)) {
  if (!file.endsWith('.js')) continue

  const integration = require(join(integrationsDir, file))

  orchestrion.push(...integration.orchestrion)
  plugins[integration.plugin.id] = integration.plugin

  const moduleNames = new Set()
  for (const entry of integration.orchestrion) {
    moduleNames.add(entry.module.name)
  }

  for (const name of moduleNames) {
    hookEntries[name] = createHookRegistrar(name)
  }
}

/**
 * @param {string} moduleName
 * @returns {function(): void}
 */
function createHookRegistrar (moduleName) {
  return () => {
    const { addHook, getHooks } = require('../../datadog-instrumentations/src/helpers/instrument')

    for (const hook of getHooks(moduleName)) {
      addHook(hook, moduleExports => moduleExports)
    }
  }
}

module.exports = { orchestrion, plugins, hookEntries }
