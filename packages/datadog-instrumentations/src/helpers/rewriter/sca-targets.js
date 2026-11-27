'use strict'

// sca-instrumentations.json lists the vulnerable functions that Runtime SCA reachability rewrites to report their
// execution, as code-transformer configs. It is generated from the reachable-symbol advisories and never lists a
// file that is already an APM rewrite target.
const instrumentations = require('./sca-instrumentations.json')

const NODE_MODULES = '/node_modules/'

/** @type {Map<string, string>} module path (`name/filePath`) to module name */
const targets = new Map()
for (const { module: { name, filePath } } of instrumentations) {
  targets.set(`${name}/${filePath}`, name)
}

/** @type {boolean|undefined} */
let enabled

/**
 * @param {string} filename Path or `file://` URL, with forward slashes
 * @returns {import('./targets').RewriteTarget|undefined}
 */
function getScaRewriteTarget (filename) {
  if (targets.size === 0) return

  const nodeModulesIndex = filename.lastIndexOf(NODE_MODULES)
  if (nodeModulesIndex === -1) return

  const modulePath = filename.slice(nodeModulesIndex + NODE_MODULES.length)
  const moduleName = targets.get(modulePath)
  if (moduleName === undefined || !isScaEnabled()) return

  return { moduleName, filePath: modulePath.slice(moduleName.length + 1) }
}

function isScaEnabled () {
  // Read on the first target only: loader workers do not load the configuration otherwise.
  enabled ??= require('../../../../dd-trace/src/config/helper')
    .getValueFromEnvSources('DD_APPSEC_SCA_ENABLED') === true
  return enabled
}

module.exports = { getScaRewriteTarget, instrumentations }
