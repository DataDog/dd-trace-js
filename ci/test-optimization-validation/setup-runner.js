'use strict'

const path = require('path')

const { runCommand } = require('./command-runner')

async function runSetupCommands ({ framework, out, options }) {
  const commands = framework.setup?.commands || []
  const results = []
  const artifacts = []

  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]
    const outDir = path.join(out, 'setup', sanitize(framework.id), `${index + 1}-${sanitize(command.id || 'setup')}`)
    // eslint-disable-next-line no-await-in-loop
    const result = await runCommand(command, {
      artifactRoot: out,
      envMode: 'clean',
      outDir,
      label: `${framework.id}:setup:${command.id || index + 1}`,
      repositoryRoot: options.repositoryRoot,
      verbose: options.verbose,
    })
    const summary = summarizeSetupCommand(command, result, outDir)
    results.push(summary)
    artifacts.push(result.artifacts.command, result.artifacts.stdout, result.artifacts.stderr)

    if (command.required !== false && result.exitCode !== 0) {
      const failure = getSetupFailure(framework, command, result, results)
      failure.artifacts.push(...artifacts)
      return {
        ok: false,
        results,
        artifacts,
        failure,
      }
    }
  }

  return { ok: true, results, artifacts }
}

function getSetupFailure (framework, command, result, setupCommands) {
  const setupName = command.description || command.id || result.command

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'blocked',
    diagnosis: `Validation is blocked by required project setup: ${setupName}. ` +
      'No Test Optimization conclusion was reached for this framework.',
    evidence: {
      blockedByProjectSetup: true,
      setupFailed: true,
      setupCommand: {
        id: command.id,
        description: command.description,
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutSummary: tail(result.stdout),
        stderrSummary: tail(result.stderr),
      },
      setupCommands,
      recommendation: 'Run or fix the documented project setup command, then rerun validation for this framework.',
    },
    artifacts: [],
  }
}

function summarizeSetupCommand (command, result, outDir) {
  return {
    id: command.id,
    description: command.description,
    required: command.required !== false,
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    artifactDirectory: outDir,
  }
}

function tail (value) {
  return String(value || '').trim().split(/\r?\n/).slice(-20).join('\n')
}

function sanitize (value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

module.exports = { runSetupCommands }
