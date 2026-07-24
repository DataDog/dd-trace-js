'use strict'

const targets = require('./targets.json')

const NODE_MODULES = '/node_modules/'

/**
 * @typedef {object} RewriteTarget
 * @property {string} moduleName
 * @property {string} filePath
 */

/**
 * @param {string} filename
 * @returns {RewriteTarget|undefined}
 */
function getRewriteTarget (filename) {
  const nodeModulesIndex = filename.lastIndexOf(NODE_MODULES)
  if (nodeModulesIndex === -1) return

  const modulePath = filename.slice(nodeModulesIndex + NODE_MODULES.length)
  const moduleName = targets[modulePath]
  if (typeof moduleName !== 'string') return

  return {
    moduleName,
    filePath: modulePath.slice(moduleName.length + 1),
  }
}

module.exports = { getRewriteTarget }
