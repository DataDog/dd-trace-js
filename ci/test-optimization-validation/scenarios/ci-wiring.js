'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiRemediation, getConfiguredTransport } = require('../ci-remediation')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const {
  environmentNamesEqual,
  findEnvironmentEntry,
  getEnvironmentValue,
  mergeEnvironment,
} = require('../environment')
const { splitNodeOptions } = require('../executable')
const { fail, incomplete } = require('./helpers')

// eslint-disable-next-line eslint-rules/eslint-env-aliases
const API_KEY_ENV_ALIAS = 'DATADOG_API_KEY'
const MAX_STATIC_COMMAND_LENGTH = 64 * 1024
const MAX_STATIC_COMMAND_WORDS = 256
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'yarnpkg'])
const COVERAGE_WRAPPERS = new Set(['c8', 'nyc'])
const COVERAGE_OPTIONS_WITH_VALUE = new Set([
  '--branches',
  '--cache-dir',
  '--cwd',
  '--exclude',
  '--extension',
  '--functions',
  '--ignore-class-methods',
  '--include',
  '--lines',
  '--nycrc-path',
  '--parser-plugins',
  '--report-dir',
  '--reporter',
  '--require',
  '--statements',
  '-e',
  '-i',
  '-n',
  '-r',
  '-x',
])
const NPX_OPTIONS_WITH_VALUE = new Set([
  '--cache',
  '--node-options',
  '--package',
  '--registry',
  '--userconfig',
  '-p',
])
const STATIC_ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/
const RUNNER_NAMES = {
  cucumber: new Set(['cucumber', 'cucumber-js']),
  cypress: new Set(['cypress']),
  jest: new Set(['jest']),
  mocha: new Set(['mocha']),
  playwright: new Set(['playwright']),
  vitest: new Set(['vitest']),
}

/**
 * Audits the recorded CI configuration without executing repository CI commands.
 *
 * @param {object} input audit input
 * @param {object} input.manifest validation manifest
 * @param {object} input.framework framework manifest entry
 * @returns {object} CI configuration audit result
 */
function runCiWiring ({ manifest, framework }) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return incomplete(framework, 'ci-wiring',
      `The CI configuration audit is incomplete: ${contradiction.reason}`, {
        ciCommandCandidate: buildCiCommandCandidate(framework),
        ciWiring: framework.ciWiring,
        ciDiscovery: contradiction.ciDiscovery,
        conclusion: 'incomplete',
        domain: 'ci_configuration',
        evidenceStrength: 'unknown',
        recommendation: contradiction.recommendation,
      })
  }

  const ciWiring = framework.ciWiring || {}
  const ciScope = getCiScope(ciWiring)
  const nodeOptionsPropagation = analyzeNodeOptionsPropagation(framework, manifest)
  const nodeOptionsRemoval = nodeOptionsPropagation?.status === 'removed'
    ? getNodeOptionsRemoval(nodeOptionsPropagation)
    : undefined
  const initializationStatus = getStaticInitializationStatus(framework, nodeOptionsPropagation)
  const transport = getConfiguredTransport(framework)
  const transportEvidence = ciWiring.transport || { mode: 'unknown', evidence: [] }
  const apiKeyConfigured = hasApiKeyReference(framework)
  const evidence = {
    ciCommandCandidate: buildCiCommandCandidate(framework),
    ciWiring,
    initializationStatus,
    nodeOptionsRemoval,
    nodeOptionsPropagation,
    transport,
    transportEvidence,
    apiKeyConfigured,
    domain: 'ci_configuration',
    evidenceStrength: 'confirmed_static',
  }

  const unresolvedCiEvidence = getUnresolvedCiEvidence(ciWiring, framework, manifest)
  if (unresolvedCiEvidence) {
    evidence.conclusion = 'incomplete'
    evidence.evidenceStrength = 'unknown'
    if (unresolvedCiEvidence.representativeMatch) {
      evidence.representativeMatch = unresolvedCiEvidence.representativeMatch
    }
    evidence.recommendation = unresolvedCiEvidence.recommendation
    return incomplete(
      framework,
      'ci-wiring',
      unresolvedCiEvidence.diagnosis,
      evidence
    )
  }

  const ciRemediation = buildCiRemediation(framework)
  evidence.ciRemediation = ciRemediation

  if (nodeOptionsPropagation?.status === 'unknown') {
    evidence.conclusion = 'incomplete'
    evidence.evidenceStrength = 'unknown'
    evidence.recommendation = 'Resolve the dynamic NODE_OPTIONS expression in the identified package-script chain. ' +
      'Confirm its effective literal value immediately before the selected test runner starts.'
    return incomplete(
      framework,
      'ci-wiring',
      'The identified test command uses a dynamic NODE_OPTIONS expression. Static analysis cannot prove whether it ' +
        'preserves, removes, or reconstructs the Datadog preload, so propagation remains incomplete.',
      evidence
    )
  }

  if (nodeOptionsRemoval) {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = getNodeOptionsRemovalRecommendation(nodeOptionsRemoval)
    return fail(
      framework,
      'ci-wiring',
      getNodeOptionsRemovalDiagnosis({ evidence, framework }),
      evidence
    )
  }

  if (initializationStatus === 'not_configured') {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = ciRemediation.summary
    return fail(
      framework,
      'ci-wiring',
      `${ciScope} does not configure NODE_OPTIONS with dd-trace/ci/init, so Test Optimization is not initialized. ` +
        'This conclusion comes from the recorded CI configuration; no project CI command was run.',
      evidence
    )
  }

  if (initializationStatus === 'configured' && transport === 'agentless' && !apiKeyConfigured) {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = 'Provide DD_API_KEY from the CI secret store for the identified test job.'
    return fail(
      framework,
      'ci-wiring',
      'The identified CI test job enables agentless Test Optimization reporting but does not record DD_API_KEY as ' +
        'a required CI secret. Test data cannot be sent agentlessly without that key.',
      evidence
    )
  }

  if (initializationStatus === 'configured' && transport === 'none') {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = ciRemediation.summary
    return fail(
      framework,
      'ci-wiring',
      'The completed CI review confirms that the identified test job has no Test Optimization reporting transport. ' +
        'Configure agentless reporting with a DD_API_KEY secret reference, or make a Datadog Agent reachable from ' +
        'the test process.',
      evidence
    )
  }

  if (initializationStatus === 'configured' &&
    ((transport === 'agentless' && apiKeyConfigured) || transport === 'agent')) {
    evidence.conclusion = 'configured_propagation_unverified'
    evidence.evidenceStrength = 'inferred_static'
    evidence.recommendation = 'Rerun the exact identified CI test step with `DD_TRACE_DEBUG=1`. Inspect whether ' +
      '`dd-trace/ci/init` initializes in the final test-runner process; do not change project configuration from ' +
      'this static result alone.'
    return incomplete(
      framework,
      'ci-wiring',
      'The identified CI job contains the required Test Optimization initialization and reporting transport. ' +
        'Static analysis found no explicit environment reset, but it cannot prove that NODE_OPTIONS reaches the ' +
        'final test process through every wrapper. CI propagation remains unverified.',
      evidence
    )
  }

  evidence.conclusion = 'incomplete'
  evidence.evidenceStrength = initializationStatus === 'configured' ? 'inferred_static' : 'unknown'
  evidence.recommendation = initializationStatus === 'configured'
    ? 'Determine whether the selected CI test job uses agentless reporting or a Datadog Agent. For agentless ' +
      'reporting, record DD_CIVISIBILITY_AGENTLESS_ENABLED and the DD_API_KEY secret reference. For an Agent, ' +
      'record the job service or sidecar evidence; runtime reachability remains unverified.'
    : 'Record whether the identified CI test job configures NODE_OPTIONS with dd-trace/ci/init and whether it uses ' +
      'agentless reporting or a reachable Datadog Agent.'
  return incomplete(
    framework,
    'ci-wiring',
    initializationStatus === 'configured'
      ? 'The CI job configures Test Optimization initialization, but the reporting transport or final-process ' +
        'propagation could not be established from static evidence.'
      : 'The CI configuration audit could not determine whether the identified test job initializes Test ' +
        'Optimization. No CI configuration conclusion was reached.',
    evidence
  )
}

/**
 * Requires a concrete test job and resolved wrapper review before accepting any negative CI conclusion.
 *
 * @param {object} ciWiring static CI evidence
 * @param {object} framework framework manifest entry
 * @param {object} manifest validation manifest
 * @returns {{diagnosis: string, recommendation: string, representativeMatch?: object}|undefined}
 * unresolved evidence details
 */
function getUnresolvedCiEvidence (ciWiring, framework, manifest) {
  const missing = []
  if (typeof ciWiring.configFile !== 'string' || !ciWiring.configFile.trim()) missing.push('workflow file')
  if (typeof ciWiring.job !== 'string' || !ciWiring.job.trim()) missing.push('test job')
  if (typeof ciWiring.command !== 'string' || !ciWiring.command.trim()) missing.push('exact test command')
  if (!Array.isArray(ciWiring.unresolved)) missing.push('wrapper-review result')

  const unresolved = Array.isArray(ciWiring.unresolved)
    ? ciWiring.unresolved.filter(value => typeof value === 'string' && value.trim())
    : []
  const representativeMatch = getCiRepresentativeMatch(ciWiring, framework, manifest)
  if (missing.length === 0 && unresolved.length === 0 && representativeMatch?.matched === true) return

  const details = [
    ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
    ...(unresolved.length > 0 ? [`unresolved: ${unresolved.join('; ')}`] : []),
    ...(representativeMatch ? [] : ['project identity and test-command anchor were not proven']),
    ...(representativeMatch?.matched === false ? [representativeMatch.reason] : []),
  ].join('. ')
  return {
    diagnosis: 'The CI configuration audit did not resolve the complete test job and wrapper chain ' +
      `(${details}). Reusable workflows, includes, inherited configuration, or wrapper scripts may still provide, ` +
      'remove, or alter Test Optimization settings. No confirmed CI misconfiguration was reported.',
    recommendation: 'Resolve the actual CI test job, exact command, and wrapper chain; record any remaining unknowns ' +
      'and verify that they reach the selected local project before confirming that a required Test Optimization ' +
      'setting is missing or removed.',
    representativeMatch,
  }
}

/**
 * Verifies that recorded CI evidence points to the project selected for local validation.
 *
 * @param {object} ciWiring static CI evidence
 * @param {object} framework framework manifest entry
 * @param {object} manifest validation manifest
 * @returns {{matched: boolean, reason: string}|undefined} structural representative match
 */
function getCiRepresentativeMatch (ciWiring, framework, manifest) {
  const repositoryRoot = manifest.repository?.root
  const projectRoot = framework.project?.root
  if (typeof repositoryRoot !== 'string' || typeof projectRoot !== 'string') {
    return {
      matched: false,
      reason: 'the repository and selected project roots were not both recorded',
    }
  }

  const repository = path.resolve(repositoryRoot)
  const project = path.resolve(projectRoot)
  const wrapperCommands = getCiWrapperCommands(ciWiring)
  const terminalTestCommand = ciWiring.terminalTestCommand
  const source = [
    ciWiring.command,
    ...wrapperCommands,
    ...(Array.isArray(ciWiring.packageScriptExpansionChain) ? ciWiring.packageScriptExpansionChain : []),
    terminalTestCommand?.command,
    terminalTestCommand?.projectRoot,
  ].filter(value => typeof value === 'string').join('\n').replaceAll('\\', '/')
  const localCommand = framework.existingTestCommand
  const localSource = [
    localCommand?.shellCommand,
    ...(Array.isArray(localCommand?.argv) ? localCommand.argv : []),
  ].filter(value => typeof value === 'string').join(' ').replaceAll('\\', '/')
  const ciVitestMode = terminalTestCommand?.framework === 'vitest'
    ? terminalTestCommand.mode
    : getVitestMode(source)
  const localVitestMode = getVitestMode(localSource)
  if (framework.framework === 'vitest' && ciVitestMode && localVitestMode && ciVitestMode !== localVitestMode) {
    return {
      matched: false,
      reason: 'the recorded CI command selects a different Vitest browser/Node mode than the local representative',
    }
  }

  const representativeAnchor = getRepresentativeCommandAnchor({
    ciWiring,
    framework,
    localCommand,
  })

  let projectIdentity
  if (typeof terminalTestCommand?.projectRoot === 'string') {
    const terminalProject = path.resolve(repository, terminalTestCommand.projectRoot)
    const relative = path.relative(project, terminalProject)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      projectIdentity = 'The terminal CI test command identifies the selected project.'
    }
  }
  if (typeof ciWiring.workingDirectory === 'string' && ciWiring.workingDirectory.trim()) {
    const workingDirectory = path.resolve(repository, ciWiring.workingDirectory)
    const relative = path.relative(project, workingDirectory)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      projectIdentity = 'The CI working directory is inside the selected project.'
    }
  }

  if (project === repository && !ciWiring.workingDirectory) {
    projectIdentity = 'The selected project is the repository root and the CI command uses its default scope.'
  }

  const relativeProject = path.relative(repository, project).replaceAll('\\', '/')
  const pathIdentifiers = [
    relativeProject,
    ...(framework.project?.configFiles || []).map(filename => {
      return path.relative(repository, filename).replaceAll('\\', '/')
    }),
  ].filter(value => typeof value === 'string' && value.length >= 3)
  const projectName = framework.project?.name
  const namedProject = typeof projectName === 'string' && projectName.length >= 3 && new RegExp(
    `(?:^|[^A-Za-z0-9@/_.-])${escapeRegex(projectName)}(?:$|[^A-Za-z0-9@/_.-])`
  ).test(source)
  if (pathIdentifiers.some(identifier => source.includes(identifier)) || namedProject) {
    projectIdentity ||= 'The CI command or wrapper chain names the selected project.'
  }

  if (!projectIdentity) {
    return {
      matched: false,
      reason: `the recorded CI command and wrapper chain do not reference selected project ${relativeProject}`,
    }
  }
  if (!representativeAnchor) {
    return {
      matched: false,
      reason: 'the CI command is not anchored to a structurally proven test command for the selected package ' +
        'script or framework runner',
    }
  }

  return { matched: true, reason: `${projectIdentity} ${representativeAnchor}` }
}

/**
 * Finds a concrete link between recorded CI evidence and the selected local representative.
 *
 * @param {object} input anchor inputs
 * @param {object} input.ciWiring recorded CI evidence
 * @param {object} input.framework selected framework
 * @param {object} input.localCommand selected local command
 * @returns {string|undefined} matching anchor description
 */
function getRepresentativeCommandAnchor ({ ciWiring, framework, localCommand }) {
  const scriptName = getPackageScriptName(localCommand)
  const terminalTestCommand = ciWiring.terminalTestCommand
  if (terminalTestCommand?.command) {
    if (terminalTestCommand.framework !== framework.framework) return
    const anchor = getInvocationAnchor(
      getTerminalStaticCommandWords(terminalTestCommand.command),
      framework.framework,
      scriptName
    )
    if (!anchor || !isTerminalCommandLinked(ciWiring, terminalTestCommand.command)) return
    return `The recorded terminal test command ${anchor}.`
  }

  let resolvedChainAnchor
  let hasResolvedChain = false
  for (const chain of [ciWiring.wrapperChain, ciWiring.packageScriptExpansionChain]) {
    if (!Array.isArray(chain)) continue
    let terminal
    for (let index = chain.length - 1; index >= 0; index--) {
      const command = getCiWrapperCommand(chain[index])
      if (!command) continue
      terminal = command
      break
    }
    if (!terminal) continue
    hasResolvedChain = true
    const anchor = getInvocationAnchor(getTerminalStaticCommandWords(terminal), framework.framework, scriptName)
    if (!anchor) return
    resolvedChainAnchor ||= anchor
  }

  if (hasResolvedChain) {
    return `The resolved wrapper chain ends in a command that ${resolvedChainAnchor}.`
  }

  const ciInvocation = getTerminalStaticCommandWords(ciWiring.command)
  const ciAnchor = getInvocationAnchor(ciInvocation, framework.framework, scriptName)
  if (ciAnchor) return `The CI command ${ciAnchor}.`
}

/**
 * Returns exact command text from a legacy or structured wrapper-chain entry.
 *
 * @param {unknown} wrapper wrapper-chain entry
 * @returns {string|undefined} exact wrapper command
 */
function getCiWrapperCommand (wrapper) {
  if (typeof wrapper === 'string' && wrapper.trim()) return wrapper
  if (wrapper && typeof wrapper === 'object' && typeof wrapper.command === 'string' && wrapper.command.trim()) {
    return wrapper.command
  }
}

/**
 * Returns exact commands from the recorded wrapper chain.
 *
 * @param {object} ciWiring static CI evidence
 * @returns {string[]} exact wrapper commands
 */
function getCiWrapperCommands (ciWiring) {
  const commands = []
  for (const wrapper of ciWiring.wrapperChain || []) {
    const command = getCiWrapperCommand(wrapper)
    if (command) commands.push(command)
  }
  return commands
}

/**
 * Verifies that the extracted terminal command appears in the final reviewed wrapper hop.
 *
 * @param {object} ciWiring static CI evidence
 * @param {string} terminalCommand extracted terminal command
 * @returns {boolean} whether the terminal command is linked to the reviewed CI command
 */
function isTerminalCommandLinked (ciWiring, terminalCommand) {
  const wrapperCommands = getCiWrapperCommands(ciWiring)
  const parent = wrapperCommands.at(-1) || ciWiring.command
  const parentWords = getTerminalStaticCommandWords(parent)
  const terminalWords = getTerminalStaticCommandWords(terminalCommand)
  if (!parentWords || !terminalWords || terminalWords.length > parentWords.length) return false

  const terminalStart = parentWords.length - terminalWords.length
  if (!terminalWords.every((word, index) => word === parentWords[terminalStart + index])) return false
  if (terminalStart === 0 || parentWords[terminalStart - 1] === '--') return true
  return isTransparentTerminalPrefix(parentWords.slice(0, terminalStart))
}

/**
 * Accepts only wrappers whose static arguments cannot replace or reinterpret the terminal command.
 *
 * @param {string[]} words words before the recorded terminal command
 * @returns {boolean} whether every prefix word is a transparent wrapper argument
 */
function isTransparentTerminalPrefix (words) {
  let index = 0
  while (index < words.length) {
    const wrapper = getCommandName(words[index++])
    if (wrapper === 'cross-env') {
      while (index < words.length && STATIC_ENV_ASSIGNMENT_PATTERN.test(words[index])) index++
      continue
    }
    if (COVERAGE_WRAPPERS.has(wrapper)) {
      index = consumeStaticWrapperOptions(words, index, COVERAGE_OPTIONS_WITH_VALUE)
      if (index < 0) return false
      continue
    }
    if (wrapper === 'npx') {
      index = consumeStaticWrapperOptions(words, index, NPX_OPTIONS_WITH_VALUE, {
        rejectedOptions: new Set(['--call', '-c']),
      })
      if (index < 0) return false
      continue
    }
    return false
  }
  return true
}

/**
 * Consumes static wrapper flags while rejecting option forms that execute source text.
 *
 * @param {string[]} words complete prefix words
 * @param {number} index first wrapper option
 * @param {Set<string>} optionsWithValue options whose value is the next word
 * @param {{rejectedOptions?: Set<string>}} [options] parser options
 * @returns {number} next unconsumed word, or -1 for an invalid prefix
 */
function consumeStaticWrapperOptions (words, index, optionsWithValue, options = {}) {
  while (index < words.length) {
    const option = words[index]
    if (options.rejectedOptions?.has(option)) return -1
    if (option === '--') {
      index++
      continue
    }
    if (!option.startsWith('-')) break
    index++
    if (!option.includes('=') && optionsWithValue.has(option)) {
      if (index >= words.length) return -1
      index++
    }
  }
  return index
}

/**
 * Describes a structurally parsed package-script or runner invocation.
 *
 * @param {string[]|undefined} words inert command words
 * @param {string} framework selected framework
 * @param {string|undefined} scriptName selected package script
 * @returns {string|undefined} invocation description
 */
function getInvocationAnchor (words, framework, scriptName) {
  if (!words) return
  const packageInvocation = getPackageManagerInvocation(words)
  if (scriptName && packageInvocation?.scriptName === scriptName) {
    return `invokes selected package script ${scriptName}`
  }
  if (packageInvocation?.runner && isFrameworkRunner(packageInvocation.runner, framework)) {
    return `invokes the selected ${framework} runner`
  }
  const npxRunner = getNpxRunner(words)
  if (npxRunner && isFrameworkRunner(npxRunner, framework)) {
    return `invokes the selected ${framework} runner`
  }

  const commandName = getCommandName(words[0])
  if (isFrameworkRunner(commandName, framework)) return `invokes the selected ${framework} runner`
  if (!['node', 'node.exe'].includes(commandName)) return
  const program = getNodeProgram(words.slice(1))
  if (program && isFrameworkRunner(program, framework)) return `invokes the selected ${framework} runner`
}

/**
 * Parses a static npx runner invocation without accepting its source-evaluation mode.
 *
 * @param {string[]} words inert command words
 * @returns {string|undefined} selected runner
 */
function getNpxRunner (words) {
  if (getCommandName(words[0]) !== 'npx') return
  const index = consumeStaticWrapperOptions(words, 1, NPX_OPTIONS_WITH_VALUE, {
    rejectedOptions: new Set(['--call', '-c']),
  })
  if (index < 0 || typeof words[index] !== 'string') return
  return words[index]
}

/**
 * Returns a package script selected by a structured project command.
 *
 * @param {object} command local project command
 * @returns {string|undefined} selected package script
 */
function getPackageScriptName (command) {
  const argv = command?.argv
  if (!Array.isArray(argv) || argv.length < 2) return
  const manager = path.basename(argv[0]).replace(/\.cmd$/i, '').toLowerCase()
  if (['node', 'node.exe'].includes(manager) && argv[2] === 'run' && typeof argv[3] === 'string') return argv[3]
  return getPackageManagerInvocation(argv)?.scriptName
}

/**
 * Parses one package-manager command without evaluating scripts or configuration.
 *
 * @param {string[]} words inert command words
 * @returns {{scriptName?: string, runner?: string}|undefined} selected action
 */
function getPackageManagerInvocation (words) {
  let index = 0
  let manager = getCommandName(words[index])
  if (manager === 'corepack') manager = getCommandName(words[++index])
  if (!PACKAGE_MANAGERS.has(manager)) return
  index++

  if (manager === 'yarn' && words[index] === 'workspace' && typeof words[index + 1] === 'string') {
    index += 2
  }

  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index++]
    if (['--cwd', '--dir', '--filter', '--workspace', '-C', '-F', '-w'].includes(option)) index++
  }

  if (['run', 'run-script'].includes(words[index])) index++
  if (['exec', 'x'].includes(words[index])) {
    index++
    if (words[index] === '--') index++
    return typeof words[index] === 'string' ? { runner: words[index] } : undefined
  }

  const action = words[index]
  if (typeof action !== 'string') return
  if ((manager === 'pnpm' || manager === 'yarn') && isAnyFrameworkRunner(action)) {
    return { runner: action }
  }
  return { scriptName: action }
}

/**
 * Extracts one bounded static command and the source offset of its executable.
 *
 * @param {unknown} source recorded command source
 * @param {number} [sourceOffset] offset of source within the complete command
 * @returns {{invocationIndex: number, words: string[]}|undefined} parsed invocation
 */
function getStaticCommand (source, sourceOffset = 0) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_STATIC_COMMAND_LENGTH) return
  const tokens = []
  let word = ''
  let wordIndex = -1
  let started = false
  let quote
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (!quote && (character === '\n' || character === '\r' || ';&|<>`()'.includes(character))) return
    if (!quote && /\s/.test(character)) {
      if (started) tokens.push({ index: wordIndex, value: word })
      if (tokens.length > MAX_STATIC_COMMAND_WORDS) return
      word = ''
      wordIndex = -1
      started = false
      continue
    }
    if (character === "'" || character === '"') {
      if (!quote) {
        quote = character
        if (!started) wordIndex = index
        started = true
        continue
      }
      if (quote === character) {
        quote = undefined
        continue
      }
    }
    if (character === '\\' && source[index + 1] && quote !== "'") {
      if (!started) wordIndex = index
      word += source[++index]
      started = true
      continue
    }
    if (!started) wordIndex = index
    word += character
    started = true
  }
  if (quote) return
  if (started) tokens.push({ index: wordIndex, value: word })
  if (tokens.length === 0 || tokens.length > MAX_STATIC_COMMAND_WORDS) return

  let index = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]?.value || '')) index++
  if (getCommandName(tokens[index]?.value) === 'env') {
    index++
    while (index < tokens.length) {
      const value = tokens[index].value
      if (value === '--') {
        index++
        break
      }
      if (['-u', '--unset'].includes(value)) {
        index += 2
        continue
      }
      if (/^(?:-u.+|--unset=)/.test(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        index++
        continue
      }
      if (value.startsWith('-')) return
      break
    }
  }
  const invocation = tokens.slice(index)
  const command = invocation[0]?.value
  if (!command || command.includes('$') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) return
  return {
    invocationIndex: sourceOffset + invocation[0].index,
    words: invocation.map(token => token.value),
  }
}

/**
 * Extracts the final simple command from a bounded sequential shell command.
 *
 * @param {unknown} source recorded command source
 * @returns {string[]|undefined} final literal command words
 */
function getTerminalStaticCommandWords (source) {
  return getTerminalStaticCommand(source)?.words
}

/**
 * Extracts the final simple command and its executable offset.
 *
 * @param {unknown} source recorded command source
 * @returns {{invocationIndex: number, words: string[]}|undefined} parsed terminal invocation
 */
function getTerminalStaticCommand (source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_STATIC_COMMAND_LENGTH) return
  let quote
  let segmentStart = 0
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '\\' && source[index + 1] && quote !== "'") {
      index++
      continue
    }
    if (character === "'" || character === '"') {
      if (!quote) {
        quote = character
      } else if (quote === character) {
        quote = undefined
      }
      continue
    }
    if (quote) continue
    if ('<>`()'.includes(character) || character === '|') return
    if (character === '&') {
      if (source[index + 1] !== '&') return
      segmentStart = ++index + 1
      continue
    }
    if (character === ';' || character === '\n' || character === '\r') {
      segmentStart = index + 1
    }
  }
  if (quote) return
  const segment = source.slice(segmentStart)
  const leadingWhitespace = segment.length - segment.trimStart().length
  return getStaticCommand(segment.trim(), segmentStart + leadingWhitespace)
}

/**
 * Finds the Node.js program while refusing unknown options before it.
 *
 * @param {string[]} args Node.js arguments
 * @returns {string|undefined} program entrypoint
 */
function getNodeProgram (args) {
  const separateValueOptions = new Set([
    '-r', '--conditions', '--experimental-loader', '--import', '--loader', '--require',
  ])
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!argument.startsWith('-')) return argument
    const option = argument.split('=', 1)[0]
    if (separateValueOptions.has(option)) {
      if (!argument.includes('=')) index++
      continue
    }
    if (/^--(?:enable-source-maps|experimental-vm-modules|max-old-space-size=\d+|no-warnings)$/.test(argument)) {
      continue
    }
    return
  }
}

/**
 * Checks a literal command or entrypoint against the selected framework runner.
 *
 * @param {string} value executable or Node.js entrypoint
 * @param {string} framework selected framework
 * @returns {boolean} whether the value selects that runner
 */
function isFrameworkRunner (value, framework) {
  const names = RUNNER_NAMES[framework]
  if (!names) return false
  const commandName = getCommandName(value)
  if (names.has(commandName)) return true
  const programName = commandName.replace(/\.(?:cjs|js|mjs)$/i, '')
  return names.has(programName)
}

/**
 * Checks whether a literal names any supported framework runner.
 *
 * @param {string} value literal executable
 * @returns {boolean} whether the executable is a supported runner
 */
function isAnyFrameworkRunner (value) {
  for (const framework of Object.keys(RUNNER_NAMES)) {
    if (isFrameworkRunner(value, framework)) return true
  }
  return false
}

/**
 * Normalizes a literal executable basename.
 *
 * @param {unknown} value executable value
 * @returns {string} normalized command name
 */
function getCommandName (value) {
  return String(value || '').split(/[\\/]/).pop().replace(/\.cmd$/i, '').toLowerCase()
}

/**
 * Identifies an explicit Vitest runner mode without executing its configuration.
 *
 * @param {string} source command and wrapper evidence
 * @returns {'browser'|'node'|undefined} statically selected mode
 */
function getVitestMode (source) {
  if (!/(?:^|[/\s])vitest(?:$|[/\s:.-])/i.test(source)) return
  return /(?:--browser(?:[=\s]|$)|(?:^|[/:_-])test[/:_-]?browser(?:$|[\s:]))/i.test(source)
    ? 'browser'
    : 'node'
}

/**
 * Escapes a literal value for use in a regular expression.
 *
 * @param {string} value literal value
 * @returns {string} escaped expression source
 */
function escapeRegex (value) {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`)
}

/**
 * Describes the precision of the recorded CI evidence without implying a job was selected.
 *
 * @param {object} ciWiring static CI evidence
 * @returns {string} customer-facing CI scope
 */
function getCiScope (ciWiring) {
  if (ciWiring.job || ciWiring.step) return 'The identified CI test job'
  if (ciWiring.configFile) return 'The inspected CI workflow'
  return 'The inspected CI configuration'
}

/**
 * Resolves the effective static Test Optimization initialization state.
 *
 * @param {object} framework manifest framework entry
 * @param {object|undefined} nodeOptionsPropagation effective NODE_OPTIONS evidence
 * @returns {'configured'|'not_configured'|'unknown'} initialization status
 */
function getStaticInitializationStatus (framework, nodeOptionsPropagation) {
  if (nodeOptionsPropagation?.status === 'restored') return 'configured'
  if (nodeOptionsPropagation?.status === 'removed') return 'not_configured'
  if (nodeOptionsPropagation?.status === 'unknown') return 'unknown'

  const recorded = framework.ciWiring?.initialization?.status
  if (recorded === 'configured' || recorded === 'not_configured') return recorded
  return 'unknown'
}

/**
 * Reports whether CI records a secret reference for agentless reporting.
 *
 * @param {object} framework manifest framework entry
 * @returns {boolean} whether an API key reference is present
 */
function hasApiKeyReference (framework) {
  const ciWiring = framework.ciWiring || {}
  const platform = getCiEnvironmentPlatform(ciWiring)
  if (framework.ciWiring?.requiredSecretEnvVars?.some(name => {
    return environmentNamesEqual(name, 'DD_API_KEY', platform) ||
      environmentNamesEqual(name, API_KEY_ENV_ALIAS, platform)
  })) return true
  const env = collectCiEnv(ciWiring, platform)
  return ['DD_API_KEY', API_KEY_ENV_ALIAS].some(name => {
    const value = getEnvironmentValue(env, name, platform)
    return typeof value === 'string' && value.length > 0
  })
}

/**
 * Collects non-secret CI environment evidence in effective scope order.
 *
 * @param {object} ciWiring static CI evidence
 * @param {string} platform child platform
 * @returns {Record<string, string>} effective environment evidence
 */
function collectCiEnv (ciWiring, platform) {
  const environment = {}
  for (const field of ['inheritedEnv', 'workflowEnv', 'jobEnv', 'stepEnv']) {
    mergeEnvironment(environment, ciWiring[field], platform)
  }
  return environment
}

function getCiEnvironmentPlatform (ciWiring) {
  const shellName = getCommandName(ciWiring.shell)
  return ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(shellName)
    ? 'win32'
    : process.platform
}

function getNodeOptionsRemovalDiagnosis ({ evidence, framework }) {
  const finding = evidence.nodeOptionsRemoval
  const frameworkName = getDisplayFrameworkName(framework.framework)
  const directCiCommand = finding.source === 'the exact CI test command'
  const ciCommand = !directCiCommand && evidence.ciCommandCandidate?.command
    ? `When CI runs \`${evidence.ciCommandCandidate.command}\`, `
    : directCiCommand ? '' : 'In the selected CI test job, '
  let source = finding.scriptName && finding.packageJson
    ? `script \`${finding.scriptName}\` in \`${finding.packageJson}\``
    : finding.source || 'the resolved CI command or wrapper'
  if (directCiCommand) source = capitalize(source)
  const replacement = finding.replacement
    ? `\`${finding.replacement}\``
    : 'an empty value'
  const findingDescription = finding.scriptName && finding.packageJson
    ? `${source} expands to \`${finding.command}\` and replaces`
    : `${source} contains \`${finding.command}\`, which replaces`

  return `${ciCommand}${findingDescription} \`NODE_OPTIONS\` with ${replacement}. ` +
    'That effective value does not contain a valid `-r` or `--require` preload for `dd-trace/ci/init`, so it ' +
    `removes the Datadog preload before ${frameworkName} starts.`
}

function getNodeOptionsRemovalRecommendation (finding) {
  const source = finding.scriptName && finding.packageJson
    ? `Script \`${finding.scriptName}\` in \`${finding.packageJson}\``
    : capitalize(finding.source || 'the resolved CI command or wrapper')
  const replacement = finding.replacement ? `\`${finding.replacement}\`` : 'an empty value'
  return `${source} replaces NODE_OPTIONS with ${replacement} before the test runner starts. Preserve the ` +
    'CI-provided value, or include `-r dd-trace/ci/init` in the literal replacement passed to the next command.'
}

/**
 * Resolves ordered literal NODE_OPTIONS replacements in CI environment and command evidence.
 *
 * @param {object} framework framework manifest entry
 * @param {object} manifest validation manifest
 * @returns {object|undefined} final statically proven propagation state
 */
function analyzeNodeOptionsPropagation (framework, manifest) {
  let result
  const ciWiring = framework.ciWiring || {}

  for (const mutation of getScopedNodeOptionsMutations(ciWiring)) {
    result = classifyNodeOptionsMutation(mutation)
  }

  for (const commandSource of getNodeOptionsCommandSources(ciWiring)) {
    const { command } = commandSource
    const invocationIndex = getTerminalStaticCommand(command)?.invocationIndex
    const mutations = getNodeOptionsMutations(
      invocationIndex === undefined ? command : command.slice(0, invocationIndex),
      ciWiring.shell
    )
    for (const mutation of mutations) {
      const packageScriptSource = findPackageScriptSource(manifest, framework, command)
      const source = packageScriptSource.scriptName
        ? { command, ...packageScriptSource }
        : { command, source: commandSource.source }
      result = classifyNodeOptionsMutation({ ...source, ...mutation })
    }
  }
  return result
}

/**
 * Returns explicit NODE_OPTIONS values in increasing CI environment scope.
 *
 * @param {object} ciWiring static CI evidence
 * @returns {object[]} ordered environment mutations
 */
function getScopedNodeOptionsMutations (ciWiring) {
  const platform = getCiEnvironmentPlatform(ciWiring)
  const mutations = []
  for (const [field, source] of [
    ['inheritedEnv', 'the inherited CI environment'],
    ['workflowEnv', 'the CI workflow environment'],
    ['jobEnv', 'the CI job environment'],
    ['stepEnv', 'the CI step environment'],
  ]) {
    const entry = findEnvironmentEntry(ciWiring[field], 'NODE_OPTIONS', platform)
    if (!entry) continue
    const replacement = entry[1] === undefined ? '' : String(entry[1]).trim()
    mutations.push({
      command: `NODE_OPTIONS=${JSON.stringify(replacement)}`,
      operation: 'replace',
      replacement,
      source,
    })
  }
  return mutations
}

/**
 * Returns unique CI command sources from the outer command to resolved inner commands.
 *
 * @param {object} ciWiring static CI evidence
 * @returns {{command: string, source: string}[]} ordered command evidence
 */
function getNodeOptionsCommandSources (ciWiring) {
  const sources = []
  const seen = new Set()
  const append = (command, source) => {
    if (typeof command !== 'string' || !command.trim() || seen.has(command)) return
    seen.add(command)
    sources.push({ command, source })
  }

  append(ciWiring.command, 'the exact CI test command')
  for (const wrapper of ciWiring.wrapperChain || []) {
    append(getCiWrapperCommand(wrapper), 'the resolved CI wrapper chain')
  }
  for (const command of ciWiring.packageScriptExpansionChain || []) {
    append(command, 'the resolved package-script chain')
  }
  append(ciWiring.terminalTestCommand?.command, 'the terminal CI test command')
  return sources
}

/**
 * Classifies one effective NODE_OPTIONS replacement.
 *
 * @param {object} mutation replacement evidence
 * @returns {object} classified propagation evidence
 */
function classifyNodeOptionsMutation (mutation) {
  if (hasDynamicEnvironmentReference(mutation.replacement)) return { ...mutation, status: 'unknown' }
  return {
    ...mutation,
    status: hasDatadogCiPreload(mutation.replacement) ? 'restored' : 'removed',
  }
}

/**
 * Checks for a valid Node.js preload option targeting the Test Optimization initializer.
 *
 * @param {string} value literal NODE_OPTIONS value
 * @returns {boolean} whether the value contains the required preload
 */
function hasDatadogCiPreload (value) {
  let args
  try {
    args = splitNodeOptions(value)
  } catch {
    return false
  }

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    let specifier
    if (argument === '-r' || argument === '--require') {
      specifier = args[++index]
    } else {
      const match = /^(?:-r|--require)=(.+)$/.exec(argument)
      specifier = match?.[1]
    }
    if (isDatadogCiInitSpecifier(specifier)) return true
  }
  return false
}

function isDatadogCiInitSpecifier (specifier) {
  if (typeof specifier !== 'string') return false
  const normalized = specifier.replaceAll('\\', '/')
  return normalized === 'dd-trace/ci/init' ||
    normalized === 'dd-trace/ci/init.js' ||
    /(?:^|\/)dd-trace\/ci\/init(?:\.js)?$/.test(normalized)
}

/**
 * Removes the analysis-only status from a confirmed NODE_OPTIONS removal.
 *
 * @param {object} propagation ordered propagation result
 * @returns {object} customer-facing removal evidence
 */
function getNodeOptionsRemoval (propagation) {
  const removal = { ...propagation }
  delete removal.index
  delete removal.status
  return removal
}

/**
 * Finds explicit NODE_OPTIONS mutations in one shell command without evaluating it.
 *
 * @param {string} command command prefix before the selected runner
 * @param {unknown} shell recorded CI shell
 * @returns {object[]} ordered mutations
 */
function getNodeOptionsMutations (command, shell) {
  const mutations = getPosixNodeOptionsMutations(command)
  const shellName = getCommandName(shell)
  if (['cmd', 'cmd.exe'].includes(shellName)) mutations.push(...getCmdNodeOptionsMutations(command))
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(shellName)) {
    mutations.push(...getPowerShellNodeOptionsMutations(command))
  }
  mutations.sort((left, right) => left.index - right.index)
  return mutations
}

/**
 * Finds POSIX assignment and removal forms.
 *
 * @param {string} command command source
 * @returns {object[]} ordered mutations
 */
function getPosixNodeOptionsMutations (command) {
  const mutations = []
  collectReplacementMatches(
    command,
    /(?:^|[\s;&|])(?:export\s+|env\s+)?NODE_OPTIONS\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;&|]*))/g,
    mutations
  )
  collectRemovalMatches(command, /(?:^|[\s;])unset\s+NODE_OPTIONS(?=$|[\s;])/g, mutations)
  collectRemovalMatches(
    command,
    /(?:^|[\s;])env\s+(?:(?:-[^\s]+\s+)*-u\s+NODE_OPTIONS|--unset(?:=|\s+)NODE_OPTIONS)(?=$|[\s;])/g,
    mutations
  )
  return mutations
}

/**
 * Finds cmd.exe set forms.
 *
 * @param {string} command command source
 * @returns {object[]} ordered mutations
 */
function getCmdNodeOptionsMutations (command) {
  const mutations = []
  collectReplacementMatches(
    command,
    /(?:^|[\s&|])set\s+(?:"NODE_OPTIONS=([^"]*)"|NODE_OPTIONS=([^\r\n&|]*))/gi,
    mutations
  )
  return mutations
}

/**
 * Finds PowerShell assignment and Env: removal forms.
 *
 * @param {string} command command source
 * @returns {object[]} ordered mutations
 */
function getPowerShellNodeOptionsMutations (command) {
  const mutations = []
  collectReplacementMatches(
    command,
    /\$env:NODE_OPTIONS\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^;\r\n|]*))/gi,
    mutations
  )
  collectRemovalMatches(
    command,
    /(?:Remove-Item|Clear-Item)(?:\s+-Path)?\s+Env:NODE_OPTIONS(?=$|[\s;])/gi,
    mutations
  )
  return mutations
}

/**
 * Appends literal replacement matches.
 *
 * @param {string} command command source
 * @param {RegExp} pattern global replacement pattern
 * @param {object[]} mutations output mutations
 */
function collectReplacementMatches (command, pattern, mutations) {
  let match
  while ((match = pattern.exec(command))) {
    const replacement = match.slice(1).find(value => value !== undefined) || ''
    mutations.push({
      index: match.index,
      operation: 'replace',
      replacement: replacement.trim(),
    })
  }
}

/**
 * Appends explicit removal matches as empty replacements.
 *
 * @param {string} command command source
 * @param {RegExp} pattern global removal pattern
 * @param {object[]} mutations output mutations
 */
function collectRemovalMatches (command, pattern, mutations) {
  let match
  while ((match = pattern.exec(command))) {
    mutations.push({ index: match.index, operation: 'replace', replacement: '' })
  }
}

/**
 * Checks whether a replacement depends on runtime environment expansion.
 *
 * @param {string} replacement recorded replacement
 * @returns {boolean} whether its literal value is unknown
 */
function hasDynamicEnvironmentReference (replacement) {
  return /(?:\$[A-Za-z_{]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%)/.test(replacement)
}

function findPackageScriptSource (manifest, framework, command) {
  const roots = new Set([manifest?.repository?.root, framework.project?.root].filter(Boolean))
  for (const root of roots) {
    const packageJsonPath = path.join(root, 'package.json')
    let packageJson
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    } catch {
      continue
    }

    for (const [scriptName, scriptCommand] of Object.entries(packageJson.scripts || {})) {
      if (scriptCommand === command) return { packageJson: packageJsonPath, scriptName }
    }
  }
  return {}
}

function getDisplayFrameworkName (frameworkName) {
  return {
    cucumber: 'Cucumber',
    cypress: 'Cypress',
    jest: 'Jest',
    mocha: 'Mocha',
    playwright: 'Playwright',
    vitest: 'Vitest',
  }[frameworkName] || frameworkName || 'test runner'
}

/**
 * Capitalizes customer-facing source text used at the start of a recommendation.
 *
 * @param {string} value source description
 * @returns {string} capitalized description
 */
function capitalize (value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

module.exports = { runCiWiring }
