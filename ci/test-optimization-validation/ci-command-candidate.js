'use strict'

const { sanitizeEnv } = require('./redaction')

/**
 * Builds the normalized static CI configuration metadata shared by reports.
 *
 * @param {object} framework manifest framework entry
 * @returns {object|undefined} CI configuration context when available
 */
function buildCiCommandCandidate (framework) {
  const ciWiring = framework.ciWiring || {}
  if (Object.keys(ciWiring).length === 0) return

  return removeUndefined({
    provider: ciWiring.provider,
    configFile: ciWiring.configFile,
    workflow: ciWiring.workflow,
    job: ciWiring.job,
    step: ciWiring.step,
    runner: ciWiring.runner,
    shell: ciWiring.shell,
    command: typeof ciWiring.command === 'string' ? ciWiring.command : undefined,
    cwd: ciWiring.workingDirectory,
    whySelected: ciWiring.whySelected || ciWiring.selectionReason || ciWiring.diagnosis,
    initialization: ciWiring.initialization,
    env: buildCiEnvSummary(ciWiring),
    packageScriptExpansionChain: getFirstArray(
      ciWiring.packageScriptExpansionChain,
      ciWiring.scriptExpansionChain,
      ciWiring.commandExpansion
    ),
    runnerToolChain: getFirstArray(
      ciWiring.runnerToolChain,
      ciWiring.toolChain,
      ciWiring.commandChain
    ),
    setupCommandIds: ciWiring.setupCommandIds,
    unresolved: ciWiring.unresolved,
  })
}

function buildCiEnvSummary (ciWiring) {
  const summary = removeUndefined({
    workflow: sanitizeEnv(ciWiring.workflowEnv || ciWiring.env?.workflow),
    job: sanitizeEnv(ciWiring.jobEnv || ciWiring.env?.job),
    step: sanitizeEnv(ciWiring.stepEnv || ciWiring.env?.step),
    inherited: sanitizeEnv(ciWiring.inheritedEnv),
  })

  return Object.keys(summary).length > 0 ? summary : undefined
}

function getFirstArray (...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value
  }
}

function removeUndefined (object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

module.exports = { buildCiCommandCandidate }
