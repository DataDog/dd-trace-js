'use strict'

const { shouldDeferLegacyFinalization } = require('../../datadog-plugin-cypress/src/finalization')
const Hook = require('./helpers/hook')

const DD_CYPRESS_LEGACY_FINALIZER_WRAPPED = Symbol.for('dd-trace.cypress.legacy-finalizer.wrapped')
const LEGACY_FINALIZER_MODULES = new Set([
  'dd-trace/packages/datadog-plugin-cypress/src/after-run.js',
  'dd-trace/packages/datadog-plugin-cypress/src/after-spec.js',
])

/**
 * @param {Function} finalizer standalone Datadog Cypress finalizer
 * @returns {Function} context-aware finalizer
 */
function wrapLegacyFinalizer (finalizer) {
  if (finalizer[DD_CYPRESS_LEGACY_FINALIZER_WRAPPED]) return finalizer

  function wrappedLegacyFinalizer () {
    if (shouldDeferLegacyFinalization()) return
    return finalizer.apply(this, arguments)
  }
  wrappedLegacyFinalizer[DD_CYPRESS_LEGACY_FINALIZER_WRAPPED] = true
  return wrappedLegacyFinalizer
}

Hook(['dd-trace'], { internals: true }, (moduleExports, moduleName) => {
  if (!LEGACY_FINALIZER_MODULES.has(moduleName.replaceAll('\\', '/'))) return moduleExports
  return wrapLegacyFinalizer(moduleExports)
})
