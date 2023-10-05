'use strict'

const plugins = require('./pluginList')

// Adds plugins for the modules without a node:* prefix to the plugin list
// ie: 'node:dns' is already associated with a plugin, and so this function assosicates 'dns' with the same plugin
const updatedPlugins = { ...plugins }
for (const pluginName in plugins) {
  if (pluginName.startsWith('node:')) {
    const packageName = pluginName.substring(5)
    updatedPlugins[packageName] = plugins[pluginName]
  }
}

module.exports = updatedPlugins
