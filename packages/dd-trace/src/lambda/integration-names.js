'use strict'

/**
 * Both spellings name the same integration.
 *
 * `lambda` predates the plugin and is what the pre-migration docs and onboarding tooling emit;
 * `aws-lambda` is the plugin id customers read in `docs/API.md`. Accepting one and silently
 * ignoring the other means a customer who asked for the integration to be off still gets it, with
 * no warning — so both are accepted everywhere the integration can be named.
 */
const LAMBDA_INTEGRATION_NAMES = new Set(['aws-lambda', 'lambda'])

/**
 * Whether a comma-separated env value names the Lambda integration under either spelling.
 *
 * Trimming lives here rather than at the call sites: the two sites previously disagreed about it,
 * so `DD_TRACE_DISABLED_INSTRUMENTATIONS="http, lambda"` skipped one check and not the other.
 *
 * @param {string | undefined} value Raw comma-separated env value.
 */
function listDisablesLambda (value) {
  if (!value) return false
  for (const name of value.split(',')) {
    if (LAMBDA_INTEGRATION_NAMES.has(name.trim())) return true
  }
  return false
}

module.exports = {
  LAMBDA_INTEGRATION_NAMES,
  listDisablesLambda,
}
