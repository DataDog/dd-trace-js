'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { expandLocalPackageScripts } = require('../ci-package-scripts')
const { buildCiRemediation } = require('../ci-remediation')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { environmentNamesEqual } = require('../environment')
const { parseLiteralEnvironmentPrefix } = require('../literal-environment')
const { fail, incomplete } = require('./helpers')

const MAX_CI_FILE_BYTES = 512 * 1024
const DYNAMIC_COMMAND_PATTERN = /[$`;&|\r\n]|%[^%\s]+%|![^!\s]+!/
const RUNNER_PATTERNS = {
  cucumber:
    /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?cucumber(?:-js)?(?:\.js)?(?:\s|$)/,
  cypress: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?cypress(?:\.js)?\s+run(?:\s|$)/,
  jest: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?jest(?:\.js)?(?:\s|$)/,
  mocha: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?mocha(?:\.js)?(?:\s|$)/,
  playwright: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?playwright(?:\.js)?\s+test(?:\s|$)/,
  vitest: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?vitest(?:\.js)?\s+(?:run|--run)(?:\s|$)/,
}

/**
 * Audits only structurally anchored, literal CI evidence.
 *
 * @param {object} input audit inputs
 * @param {object} input.manifest validation manifest
 * @param {object} input.framework framework entry
 * @param {Map<string, Buffer|undefined>} [input.projectFileSources] approval-bound project sources
 * @returns {object} CI audit result
 */
function runCiWiring ({ manifest, framework, projectFileSources }) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return getIncomplete(framework, contradiction.reason, {
      ciDiscovery: contradiction.ciDiscovery,
      recommendation: contradiction.recommendation,
    })
  }

  const ci = framework.ciWiring || {}
  const evidence = {
    ciCommandCandidate: buildCiCommandCandidate(framework),
    conclusion: 'incomplete',
    domain: 'ci_configuration',
    evidenceStrength: 'unknown',
  }
  if (hasNoSupportedCiConfiguration(manifest, ci)) {
    return getIncomplete(
      framework,
      'No supported CI configuration file was found by bounded repository discovery. The CI audit is incomplete; ' +
        'this does not prove that the repository has no external CI configuration.',
      {
        ...evidence,
        reasonCode: 'no-supported-ci-configuration',
        recommendation: 'Identify the CI system and one repository-controlled test job. If CI is configured outside ' +
          'this repository, review that configuration separately.',
      }
    )
  }
  if (hasUnavailableRemoteCiCommand(ci)) {
    return getIncomplete(
      framework,
      'The selected CI path delegates test execution to a remote action or reusable workflow whose command is not ' +
        'available in this repository. The CI audit is incomplete.',
      {
        ...evidence,
        reasonCode: 'remote-ci-command-unavailable',
        recommendation: 'Review the referenced action or reusable workflow at its pinned revision. Keep the result ' +
          'incomplete when its final test command and effective environment cannot be bound statically.',
      }
    )
  }
  const missing = getMissingReviewFields(ci)
  if (missing.length > 0) {
    return getIncomplete(
      framework,
      `The CI audit is incomplete because ${[
        `it is missing ${missing.join(', ')}`,
        ...(ci.reviewComplete === true ? [] : ['the review is not marked complete']),
      ].join(' and ')}.`,
      {
        ...evidence,
        recommendation: 'Identify one exact CI test job and resolve inherited configuration and wrappers. Leave the ' +
          'result incomplete when that cannot be proven statically.',
      }
    )
  }

  const source = readProjectSource(ci.configFile, projectFileSources)
  if (!source) {
    return getIncomplete(framework, 'The recorded CI configuration file is unavailable or too large to verify.', {
      ...evidence,
      recommendation: 'Regenerate the manifest from the current checkout and review the CI file again.',
    })
  }
  const jobSource = getSelectedJobSource(source, ci)
  if (!jobSource ||
    !containsExecutionCommand(jobSource, ci.command) ||
    (ci.step && !containsLiteral(jobSource, ci.step))) {
    return getIncomplete(
      framework,
      'The recorded command and step could not be bound structurally to the selected job in the checksum-bound ' +
        'CI file.',
      {
        ...evidence,
        recommendation: 'Record the exact YAML job key, literal step, and command from one supported CI job. Leave ' +
          'the audit incomplete when that job structure cannot be verified.',
      }
    )
  }

  const command = ci.command.trim()
  const resolution = getRunnerResolution(command, framework, ci, projectFileSources)
  const normalizedSource = jobSource.replaceAll('\\', '/')
  const hasInitialization = /dd-trace\/ci\/init(?:\.js)?\b/.test(normalizedSource)
  const matrixRelevant = matrixAffectsCiFacts(jobSource, command)
  const unresolved = classifyUnresolved(ci, resolution, matrixRelevant, jobSource)
  const initialization = getInitializationFact(ci, hasInitialization)
  const ciFacts = {
    initialization,
    matrix: {
      status: matrixRelevant ? 'affects_relevant_configuration' : 'not_relevant_to_ci_facts',
    },
    runnerInvocation: {
      ...(resolution.commandPath ? { commandPath: resolution.commandPath } : {}),
      ...(resolution.lifecycleScripts?.length > 0
        ? { lifecycleScripts: resolution.lifecycleScripts }
        : {}),
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      ...(resolution.resolvedCommand ? { resolvedCommand: resolution.resolvedCommand } : {}),
      source: resolution.source,
      status: resolution.status,
    },
    transport: getTransportFact(ci, jobSource),
    unresolved,
  }
  evidence.ciFacts = ciFacts

  const effectiveNodeOptions = resolution.status === 'confirmed'
    ? getEffectiveNodeOptionsOverride(resolution.commandPath)
    : undefined
  const remediation = buildCiRemediation(framework)
  if (resolution.status === 'confirmed' &&
    effectiveNodeOptions !== undefined &&
    !/dd-trace[\\/]ci[\\/]init(?:\.js)?\b/.test(effectiveNodeOptions) &&
    unresolved.relevant.length === 0) {
    return getFailure(
      framework,
      'The statically resolved CI test path overrides NODE_OPTIONS without the dd-trace/ci/init preload, so Test ' +
        'Optimization is not initialized in the final runner.',
      {
        ...evidence,
        ciRemediation: remediation,
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: remediation.summary,
      }
    )
  }

  if (initialization.status === 'missing' &&
    resolution.status === 'confirmed' &&
    unresolved.relevant.length === 0) {
    const transportMissing = ciFacts.transport.status === 'missing'
    return getFailure(
      framework,
      'The checksum-bound CI job reaches the selected test framework through a bounded static command path, but ' +
        `does not configure the dd-trace/ci/init preload${
          transportMissing ? ' and declares no visible Datadog Agent or agentless reporting transport' : ''
        }. Test Optimization is not configured in that job.`,
      {
        ...evidence,
        ciConfigurationStatus: 'not_configured',
        ciRemediation: remediation,
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: remediation.summary,
      }
    )
  }

  if (resolution.status !== 'confirmed') {
    let visibleFacts = ''
    if (initialization.status === 'missing') {
      visibleFacts = 'The selected job has no visible dd-trace/ci/init preload.'
    }
    if (ciFacts.transport.status === 'missing') {
      if (visibleFacts) visibleFacts += ' '
      visibleFacts += 'The recorded review found no visible Datadog Agent or agentless reporting transport.'
    }
    const recommendation = /working directory/i.test(resolution.reason)
      ? 'Keep the CI job\'s actual working directory. Resolve the repository-root wrapper to the selected test ' +
        'runner statically; do not substitute the framework package directory merely to make the audit conclusive.'
      : 'Resolve the remaining wrapper or dynamic command statically, or confirm the effective NODE_OPTIONS value ' +
        'in the final test process with DD_TRACE_DEBUG=1.'
    return getIncomplete(
      framework,
      'The CI audit remains incomplete because the selected command could not be resolved to the ' +
        `${framework.framework} runner: ${resolution.reason}. ${visibleFacts}`.trim(),
      {
        ...evidence,
        recommendation,
      }
    )
  }

  if (unresolved.relevant.length > 0) {
    return getIncomplete(
      framework,
      'The framework invocation was resolved statically, but relevant CI evidence remains unresolved: ' +
        `${unresolved.relevant.join('; ')}.`,
      {
        ...evidence,
        recommendation: 'Resolve only the listed configuration that can affect initialization, runner invocation, ' +
          'or transport. Unrelated runtime matrices do not need further analysis.',
      }
    )
  }

  if (initialization.status !== 'configured') {
    return getIncomplete(
      framework,
      'Static evidence does not establish whether dd-trace/ci/init is configured for the selected test path.',
      {
        ...evidence,
        recommendation: 'Record the literal NODE_OPTIONS configuration for this job or rerun the CI step with ' +
          'DD_TRACE_DEBUG=1.',
      }
    )
  }

  if (ci.transport?.mode === 'agentless' &&
    /DD_CIVISIBILITY_AGENTLESS_ENABLED/.test(jobSource) &&
    !/\b(?:DD_API_KEY|DATADOG_API_KEY)\b/.test(jobSource)) {
    return getIncomplete(
      framework,
      'The selected job visibly enables agentless reporting but has no Datadog API key reference in the ' +
        'checksum-bound CI file. The key may still be injected outside this file.',
      {
        ...evidence,
        ciRemediation: remediation,
        recommendation: 'Confirm that DD_API_KEY reaches this test job from the CI secret store.',
      }
    )
  }

  return getIncomplete(
    framework,
    'The selected CI job contains Test Optimization initialization, but static inspection cannot prove that the ' +
      'effective environment and reporting transport reach the final process at runtime.',
    {
      ...evidence,
      conclusion: 'configured_propagation_unverified',
      evidenceStrength: 'inferred_static',
      recommendation: 'Rerun this exact CI step with DD_TRACE_DEBUG=1 and confirm initialization in the final test ' +
        'runner.',
    }
  )
}

/**
 * Returns the final inline NODE_OPTIONS override along the resolved command path.
 *
 * @param {string[]} commandPath selected command and expanded package scripts
 * @returns {string|undefined} final literal override
 */
function getEffectiveNodeOptionsOverride (commandPath = []) {
  let value
  for (const command of commandPath) {
    for (const assignment of normalizeDirectCommand(command).assignments) {
      if (environmentNamesEqual(assignment.name, 'NODE_OPTIONS')) value = assignment.value
    }
  }
  return value
}

/**
 * Resolves a direct runner or a bounded chain of local package scripts.
 *
 * @param {string} command selected CI command
 * @param {object} framework framework manifest entry
 * @param {object} ci selected CI evidence
 * @param {Map<string, Buffer|undefined>} [projectFileSources] approval-bound project sources
 * @returns {object} static runner resolution
 */
function getRunnerResolution (command, framework, ci, projectFileSources) {
  if (getDirectRunner(command, framework.framework)) {
    return {
      commandPath: [command],
      resolvedCommand: command,
      source: 'direct_ci_command',
      status: 'confirmed',
    }
  }

  if (!ci.workingDirectory ||
    path.resolve(ci.workingDirectory) !== path.resolve(framework.project.root)) {
    return {
      reason: ci.workingDirectory
        ? 'the selected working directory does not match the approval-bound project package'
        : 'the selected package-script command has no approval-bound effective working directory',
      source: 'unresolved_wrapper',
      status: 'unresolved',
    }
  }
  const scripts = readProjectScripts(framework.project.packageJson, projectFileSources)
  if (!scripts) {
    return {
      reason: 'the approval-bound project package.json is unavailable or invalid',
      source: 'unresolved_wrapper',
      status: 'unresolved',
    }
  }
  const expansion = expandLocalPackageScripts(command, scripts)
  if (expansion.error) {
    return {
      lifecycleScripts: expansion.lifecycleScripts,
      reason: expansion.error,
      source: 'local_package_script',
      status: 'unresolved',
    }
  }
  const candidates = expansion.terminals.filter(terminal => {
    return getDirectRunner(terminal.command, framework.framework)
  })
  if (candidates.length === 0) {
    return {
      lifecycleScripts: expansion.lifecycleScripts,
      reason: 'no bounded local package-script path reaches the selected framework runner',
      source: 'unresolved_wrapper',
      status: 'unresolved',
    }
  }
  if (candidates.length > 1) {
    return {
      lifecycleScripts: expansion.lifecycleScripts,
      reason: 'more than one bounded local package-script path reaches the selected framework runner',
      source: 'unresolved_wrapper',
      status: 'unresolved',
    }
  }
  const candidate = candidates[0]
  return {
    commandPath: candidate.path,
    lifecycleScripts: expansion.lifecycleScripts,
    resolvedCommand: candidate.command,
    source: 'local_package_script',
    status: 'confirmed',
  }
}

function readProjectScripts (filename, projectFileSources) {
  try {
    const source = readProjectSource(filename, projectFileSources)
    if (source === undefined) return
    const packageJson = JSON.parse(source)
    if (!packageJson.scripts || typeof packageJson.scripts !== 'object' ||
      Array.isArray(packageJson.scripts)) return {}
    return packageJson.scripts
  } catch {}
}

function getInitializationFact (ci, hasInitialization) {
  if (ci.initialization?.status === 'configured' && hasInitialization) {
    return { status: 'configured', evidence: ci.initialization.evidence }
  }
  if (ci.initialization?.status === 'not_configured' && !hasInitialization) {
    return { status: 'missing', evidence: ci.initialization.evidence }
  }
  return {
    status: 'unresolved',
    reason: 'recorded initialization status and checksum-bound CI source do not establish the same conclusion',
  }
}

function getTransportFact (ci, jobSource) {
  const mode = ci.transport?.mode
  if (mode === 'agentless' &&
    /DD_CIVISIBILITY_AGENTLESS_ENABLED/.test(jobSource) &&
    !/\b(?:DD_API_KEY|DATADOG_API_KEY)\b/.test(jobSource)) {
    return { status: 'credentials_unverified', mode }
  }
  if (mode === 'agent' || mode === 'agentless') {
    return { status: 'configured', mode, evidence: ci.transport.evidence }
  }
  if (mode === 'none') return { status: 'missing', mode }
  return { status: 'unresolved', mode: mode || 'unknown' }
}

function classifyUnresolved (ci, resolution, matrixRelevant, jobSource) {
  const relevant = []
  const ignored = []
  const unresolved = Array.isArray(ci.unresolved) ? ci.unresolved : []
  const githubHosted = /[/\\]\.github[/\\]workflows[/\\]/.test(ci.configFile) &&
    /^[ \t]*runs-on:[ \t]*(?:ubuntu|windows|macos)-/mi.test(jobSource)

  for (const item of unresolved) {
    const isMatrix = /\bmatrix\b/i.test(item)
    const isResolvedPackagePath = resolution.status === 'confirmed' &&
      resolution.source === 'local_package_script' &&
      /\b(?:bun|lifecycle|npm|package script|pnpm|pretest|posttest|yarn)\b/i.test(item)
    const isAmbientGithubSettings = githubHosted &&
      /\b(?:repository|organization|environment)[-\s,\w]+\b(?:secrets?|variables?)\b/i.test(item) &&
      /\b(?:inject|inherit|outside)\b/i.test(item)
    const isOtherJob = /^Other jobs?\b/i.test(item) ||
      /\bsecond\b.+\bjob\b.+\bonly\b.+\bselected\b/i.test(item) ||
      /\brelease\b.+\bcontains no test job\b/i.test(item)
    if ((isMatrix && !matrixRelevant) ||
      isResolvedPackagePath ||
      isAmbientGithubSettings ||
      isOtherJob) {
      ignored.push(item)
    } else {
      relevant.push(item)
    }
  }
  if (ci.reviewComplete !== true && unresolved.length === 0) {
    relevant.push('the CI evidence review is not marked complete')
  }
  return { ignored, relevant }
}

function hasNoSupportedCiConfiguration (manifest, ci) {
  if (ci.configFile || ci.job || ci.command) return false
  const unresolved = Array.isArray(ci.unresolved) ? ci.unresolved : []
  return manifest.ciDiscovery?.found?.length === 0 ||
    unresolved.some(item => /No supported CI configuration file was found/i.test(item))
}

function hasUnavailableRemoteCiCommand (ci) {
  if (ci.command) return false
  const evidence = [
    ci.step,
    ...(Array.isArray(ci.unresolved) ? ci.unresolved : []),
  ].filter(Boolean)
  if (evidence.some(item => {
    return /\b(?:remote|external|third-party)\s+(?:action|workflow)\b/i.test(item)
  })) return true

  return evidence.some(item => {
    const reference = /^\s*uses:\s*["']?([^"'\s]+)["']?\s*$/im.exec(item)?.[1]
    return reference && !reference.startsWith('./')
  })
}

function matrixAffectsCiFacts (jobSource, command) {
  const matrixReference = /\bmatrix\s*[.[]/
  if (!matrixReference.test(jobSource)) return false
  if (matrixReference.test(command)) return true
  return jobSource.split(/\r?\n/).some(line => {
    return matrixReference.test(line) &&
      /\b(?:container|DD_[A-Z0-9_]+|DATADOG_[A-Z0-9_]+|NODE_OPTIONS|runs-on|shell|working-directory)\b/i.test(line)
  })
}

/**
 * Locates a direct runner only at the executable position after literal environment assignments.
 *
 * @param {string} command selected CI command
 * @param {string} framework framework name
 * @returns {{index: number}|undefined} direct runner location
 */
function getDirectRunner (command, framework) {
  if (DYNAMIC_COMMAND_PATTERN.test(command)) return
  const { index, source } = normalizeDirectCommand(command)
  if (!RUNNER_PATTERNS[framework]?.test(source)) return
  return { index }
}

function normalizeDirectCommand (command) {
  const prefix = parseLiteralEnvironmentPrefix(command)
  const assignments = [...prefix.assignments]
  let source = String(command).slice(prefix.length).replace(/^(?:c8|nyc)(?:\.cmd)?\s+/, '')
  if (/^cross-env(?:\.cmd)?\s+/.test(source)) {
    source = source.replace(/^cross-env(?:\.cmd)?\s+/, '')
    const crossEnv = parseLiteralEnvironmentPrefix(source)
    assignments.push(...crossEnv.assignments)
    source = source.slice(crossEnv.length)
  }
  source = source.replace(/^(?:(?:bunx|npx)(?:\.cmd)?|(?:pnpm|yarn)(?:\.cmd)?\s+exec)\s+/, '')
    .replace(/^bun x\s+/, '')
  return { assignments, index: prefix.length, source }
}

/**
 * Returns the selected YAML job block, or undefined when structural binding is unsupported.
 *
 * @param {string} source CI configuration source
 * @param {object} ci selected CI evidence
 * @returns {string|undefined} selected job source
 */
function getSelectedJobSource (source, ci) {
  if (!/\.ya?ml$/i.test(String(ci.configFile || ''))) return
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const jobName = normalizeYamlKey(ci.job)
  if (!jobName) return

  const jobsIndex = lines.findIndex(line => /^jobs:\s*(?:#.*)?$/.test(line))
  if (jobsIndex !== -1) {
    const jobsEnd = findYamlBlockEnd(lines, jobsIndex, 0)
    const entries = []
    for (let index = jobsIndex + 1; index < jobsEnd; index++) {
      const entry = getYamlKeyEntry(lines[index], index)
      if (entry) entries.push(entry)
    }
    const jobIndent = Math.min(...entries.map(entry => entry.indent))
    const selected = entries.find(entry => entry.indent === jobIndent && entry.key === jobName)
    if (selected) return getYamlBlock(lines, selected.index, selected.indent)
    return
  }

  if (!/^\.gitlab-ci\.ya?ml$/i.test(path.basename(ci.configFile))) return
  const selected = lines
    .map((line, index) => getYamlKeyEntry(line, index))
    .find(entry => entry?.indent === 0 && entry.key === jobName)
  if (selected) return getYamlBlock(lines, selected.index, selected.indent)
}

function getYamlKeyEntry (line, index) {
  if (!line || /^\s*(?:#|$)/.test(line) || /^\s/.test(line) && line.includes('\t')) return
  const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*)):\s*(?:#.*)?$/.exec(line)
  if (!match) return
  return {
    indent: match[1].length,
    index,
    key: String(match[2] ?? match[3] ?? match[4]).trim(),
  }
}

function normalizeYamlKey (value) {
  const key = String(value || '').trim().replace(/:\s*$/, '').trim()
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1)
  }
  return key
}

function getYamlBlock (lines, start, indent) {
  return lines.slice(start, findYamlBlockEnd(lines, start, indent)).join('\n')
}

function findYamlBlockEnd (lines, start, indent) {
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*(?:#|$)/.test(lines[index])) continue
    const nextIndent = /^\s*/.exec(lines[index])[0].length
    if (nextIndent <= indent) return index
  }
  return lines.length
}

/**
 * Returns missing fields required for a conclusive static audit.
 *
 * @param {object} ci CI evidence
 * @returns {string[]} missing field labels
 */
function getMissingReviewFields (ci) {
  return [
    ['CI file', ci.configFile],
    ['job', ci.job],
    ['exact command', ci.command],
  ].filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([label]) => label)
}

/**
 * Reads one bounded regular project file or its approval-bound snapshot.
 *
 * @param {string} filename project file
 * @param {Map<string, Buffer|undefined>} [projectFileSources] approval-bound project sources
 * @returns {string|undefined} source
 */
function readProjectSource (filename, projectFileSources) {
  if (typeof filename !== 'string') return
  const resolved = path.resolve(filename)
  if (projectFileSources) {
    if (!projectFileSources.has(resolved)) return
    return projectFileSources.get(resolved)?.toString('utf8')
  }
  try {
    const stat = fs.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CI_FILE_BYTES) return
    return fs.readFileSync(resolved, 'utf8')
  } catch {}
}

/**
 * Checks whether recorded text appears literally after line-ending normalization.
 *
 * @param {string} source file source
 * @param {string} value recorded value
 * @returns {boolean} literal presence
 */
function containsLiteral (source, value) {
  const normalizedSource = source.replaceAll('\r\n', '\n')
  const normalizedValue = String(value).replaceAll('\r\n', '\n').trim()
  return normalizedValue !== '' && normalizedSource.includes(normalizedValue)
}

function containsExecutionCommand (source, value) {
  const command = String(value).replaceAll('\r\n', '\n').trim()
  if (!command) return false
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  return lines.some((line, index) => {
    if (/^\s*#/.test(line)) return false
    const match = /^\s*(?:-\s*)?(?:run|script):(.*)$/.exec(line)
    if (!match) return false
    const scalar = match[1].trim()
    if (!/^\|[+-]?$/.test(scalar)) return scalar === command

    const indicatorIndent = /^\s*/.exec(line)[0].length
    const block = []
    let contentIndent
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next].trim()) {
        block.push('')
        continue
      }
      const nextIndent = /^\s*/.exec(lines[next])[0].length
      if (contentIndent === undefined) {
        if (nextIndent <= indicatorIndent) break
        contentIndent = nextIndent
      } else if (nextIndent < contentIndent) {
        break
      }
      block.push(lines[next])
    }
    if (contentIndent === undefined) return false
    const blockCommand = block.map(candidate => candidate.slice(contentIndent)).join('\n').trim()
    return blockCommand === command
  })
}

/**
 * Builds an incomplete CI result.
 *
 * @param {object} framework framework entry
 * @param {string} diagnosis diagnosis
 * @param {object} evidence evidence
 * @returns {object} result
 */
function getIncomplete (framework, diagnosis, evidence) {
  return incomplete(framework, 'ci-wiring', diagnosis, {
    ciWiring: framework.ciWiring,
    ...evidence,
  })
}

/**
 * Builds a confirmed CI failure.
 *
 * @param {object} framework framework entry
 * @param {string} diagnosis diagnosis
 * @param {object} evidence evidence
 * @returns {object} result
 */
function getFailure (framework, diagnosis, evidence) {
  return fail(framework, 'ci-wiring', diagnosis, {
    ciWiring: framework.ciWiring,
    ...evidence,
  })
}

module.exports = { runCiWiring }
