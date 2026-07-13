'use strict'

const {
  getCommandDetails,
  serializeDisplayCommand,
} = require('./command-runner')
const { sanitizeEnv } = require('./redaction')

/**
 * Builds the normalized CI command metadata shape shared by reports and UI payloads.
 *
 * @param {object} framework manifest framework entry
 * @returns {object|undefined} CI command candidate context when available
 */
function buildCiCommandCandidate (framework) {
  const ciWiring = framework.ciWiring || {}
  const command = framework.ciWiringCommand

  if (!command && !hasCiWiringContext(ciWiring)) return

  return removeUndefined({
    provider: ciWiring.provider || undefined,
    configFile: ciWiring.configFile || undefined,
    workflow: ciWiring.workflow || undefined,
    job: ciWiring.job || undefined,
    step: ciWiring.step || undefined,
    runner: ciWiring.runner || undefined,
    shell: ciWiring.shell || undefined,
    command: command ? serializeDisplayCommand(command) : ciWiring.command,
    cwd: command?.cwd || ciWiring.workingDirectory,
    whySelected: ciWiring.whySelected || ciWiring.selectionReason || ciWiring.diagnosis,
    initialization: ciWiring.initialization,
    env: buildCiEnvSummary(ciWiring, command),
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
    commandDetails: command && getCommandDetails(command),
  })
}

function buildCiEnvSummary (ciWiring, command) {
  const summary = removeUndefined({
    workflow: sanitizeEnv(ciWiring.workflowEnv || ciWiring.env?.workflow),
    job: sanitizeEnv(ciWiring.jobEnv || ciWiring.env?.job),
    step: sanitizeEnv(ciWiring.stepEnv || command?.env || ciWiring.env?.step),
    inherited: sanitizeEnv(ciWiring.inheritedEnv),
  })

  return Object.keys(summary).length > 0 ? summary : undefined
}

function hasCiWiringContext (ciWiring) {
  return Object.keys(ciWiring).length > 0
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

module.exports = {
  buildCiCommandCandidate,
}
