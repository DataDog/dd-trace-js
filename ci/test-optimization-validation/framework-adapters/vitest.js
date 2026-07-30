'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { matchesLiteralGlob } = require('../literal-glob')

const CONFIG_PATTERN = /^(?:vite\.config|vitest\.(?:config|workspace))\.[cm]?[jt]s$/
const LITERAL_PROJECT_PATTERN = /^[A-Za-z0-9_.:@/-]+$/

/**
 * Binds one literal `--project` selector to one statically named Vitest project.
 *
 * Customer configuration is read as text only. Dynamic names, roots, includes, and ambiguous matches fail closed.
 *
 * @param {object} input project inputs
 * @param {string[]} input.configFiles approval-bound configuration files
 * @param {string[]} input.projectFiles bounded project files
 * @param {string} input.projectRoot detected project root
 * @param {string[]} input.runnerArgs retained Vitest arguments
 * @returns {{
 *   configFile?: string,
 *   error?: string,
 *   files?: string[],
 *   includePatterns?: string[],
 *   root?: string
 * }|undefined} project binding
 */
function bindLiteralProject ({ configFiles, projectFiles, projectRoot, runnerArgs }) {
  const projects = getOptionValues(runnerArgs, '--project')
  if (projects.length === 0) return
  if (projects.length !== 1 || !LITERAL_PROJECT_PATTERN.test(projects[0])) {
    return { error: '--project must select exactly one literal project name' }
  }

  const name = projects[0]
  const selectedConfigs = getSelectedConfigFiles({ configFiles, projectRoot, runnerArgs })
  if (selectedConfigs.error) return selectedConfigs
  const bindings = []
  for (const configFile of selectedConfigs.files) {
    const source = readText(configFile)
    if (source === undefined) continue
    for (const property of getLiteralStringProperties(source, 'name')) {
      if (property.value !== name) continue
      const projectObject = getProjectObject(source, property.index)
      if (!projectObject) continue
      const binding = getBindingFromObject({
        configFile,
        projectFiles,
        projectObject,
        projectRoot,
        source,
      })
      if (binding.error) return binding
      bindings.push(binding)
    }
  }

  if (bindings.length !== 1) {
    return {
      error: bindings.length === 0
        ? `--project ${JSON.stringify(name)} does not map to one statically named Vitest project`
        : `--project ${JSON.stringify(name)} maps to more than one Vitest project`,
    }
  }
  return bindings[0]
}

/**
 * Selects only an explicit approval-bound config or root-level default config candidates.
 *
 * @param {object} input config selection inputs
 * @param {string[]} input.configFiles approval-bound configuration files
 * @param {string} input.projectRoot detected project root
 * @param {string[]} input.runnerArgs retained Vitest arguments
 * @returns {{error?: string, files?: string[]}} selected configuration files
 */
function getSelectedConfigFiles ({ configFiles, projectRoot, runnerArgs }) {
  const explicitConfigs = getOptionValues(runnerArgs, '--config')
  if (explicitConfigs.length > 1) {
    return { error: '--project cannot be bound with more than one explicit Vitest config' }
  }
  if (explicitConfigs.length === 1) {
    const explicitConfig = getPhysicalPath(path.resolve(projectRoot, explicitConfigs[0]))
    const selected = configFiles.find(filename => filename === explicitConfig)
    return selected
      ? { files: [selected] }
      : { error: 'the explicit Vitest config is not an approval-bound regular file' }
  }

  const physicalRoot = getPhysicalDirectory(projectRoot)
  return {
    files: configFiles.filter(filename => {
      return path.dirname(filename) === physicalRoot && CONFIG_PATTERN.test(path.basename(filename))
    }),
  }
}

function getBindingFromObject ({ configFile, projectFiles, projectObject, projectRoot, source }) {
  const rootProperty = getLiteralProperty(projectObject, 'root')
  if (rootProperty.dynamic) return { error: 'the selected Vitest project has a dynamic root' }

  const standaloneProject = /\bdefineProject\s*\(/.test(source)
  const rootBase = standaloneProject ? path.dirname(configFile) : projectRoot
  const root = rootProperty.value
    ? path.resolve(rootBase, rootProperty.value)
    : standaloneProject
      ? path.dirname(configFile)
      : projectRoot
  if (!isContainedDirectory(projectRoot, root)) {
    return { error: 'the selected Vitest project root is not a repository-contained directory' }
  }

  const include = getLiteralStringArray(projectObject, 'include')
  if (include.dynamic) return { error: 'the selected Vitest project has dynamic include patterns' }
  const files = projectFiles.filter(filename => {
    const relativeToRoot = path.relative(root, filename)
    if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return false
    if (include.values.length === 0) return true
    const normalized = relativeToRoot.replaceAll('\\', '/')
    return include.values.some(pattern => matchesLiteralGlob(normalized, pattern))
  })
  return { configFile, files, includePatterns: include.values, root }
}

function supportsGeneratedFiles (project, strategy) {
  if (project.includePatterns.length === 0) return true
  return strategy.scenarios.every(scenario => {
    const relative = path.relative(project.root, scenario.testIdentities[0].file).replaceAll('\\', '/')
    return relative && !relative.startsWith('../') &&
      project.includePatterns.some(pattern => matchesLiteralGlob(relative, pattern))
  })
}

function getProjectObject (source, nameIndex) {
  const ranges = getObjectRanges(source)
    .filter(range => range.start < nameIndex && range.end > nameIndex)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
  if (ranges.length === 0) return

  const selected = ranges[1] || ranges[0]
  return source.slice(selected.start + 1, selected.end)
}

function getObjectRanges (source) {
  const ranges = []
  const stack = []
  let quote
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (character === '\\') index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
    } else if (character === '/' && next === '*') {
      blockComment = true
      index++
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (character === '{') {
      stack.push(index)
    } else if (character === '}') {
      const start = stack.pop()
      if (start !== undefined) ranges.push({ end: index, start })
    }
  }
  return ranges
}

function getLiteralStringProperties (source, property) {
  const properties = []
  let quote
  let lineComment = false
  let blockComment = false
  let previousCodeCharacter
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (character === '\\') index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (!source.startsWith(property, index) ||
      !['{', ','].includes(previousCodeCharacter) ||
      /[A-Za-z0-9_$]/.test(source[index - 1] || '') ||
      /[A-Za-z0-9_$]/.test(source[index + property.length] || '')) {
      if (!/\s/.test(character)) previousCodeCharacter = character
      continue
    }

    const match = new RegExp(
      String.raw`^${property}\s*:\s*(["'])([^"'\\]+)\1`
    ).exec(source.slice(index))
    if (!match) {
      previousCodeCharacter = character
      continue
    }
    properties.push({ index, value: match[2] })
    previousCodeCharacter = match[0].at(-1)
    index += match[0].length - 1
  }
  return properties
}

function getLiteralProperty (source, property) {
  const literal = new RegExp(String.raw`\b${property}\s*:\s*(["'])([^"'\\]+)\1`).exec(source)
  if (literal) return { value: literal[2] }
  return { dynamic: new RegExp(String.raw`\b${property}\s*:`).test(source) }
}

function getLiteralStringArray (source, property) {
  const propertyPattern = new RegExp(String.raw`\b${property}\s*:`)
  const propertyMatch = propertyPattern.exec(source)
  if (!propertyMatch) return { values: [] }
  const tail = source.slice(propertyMatch.index + propertyMatch[0].length)
  const arrayMatch = /^\s*\[([\s\S]{0,8192}?)\]/.exec(tail)
  if (!arrayMatch) return { dynamic: true, values: [] }
  const values = [...arrayMatch[1].matchAll(/(["'])([^"'\\]+)\1/g)].map(match => match[2])
  const residue = arrayMatch[1].replaceAll(/(["'])([^"'\\]+)\1/g, '').replaceAll(',', '').trim()
  return residue ? { dynamic: true, values: [] } : { values }
}

function getOptionValues (args, expected) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index].split('=', 1)[0] !== expected) continue
    values.push(args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[++index])
  }
  return values.filter(Boolean)
}

function isContainedDirectory (root, candidate) {
  try {
    const physicalRoot = fs.realpathSync(root)
    const physicalCandidate = fs.realpathSync(candidate)
    const relative = path.relative(physicalRoot, physicalCandidate)
    return fs.statSync(physicalCandidate).isDirectory() &&
      (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
  } catch {
    return false
  }
}

function readText (filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 512 * 1024) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

/**
 * Resolves one regular non-symbolic-link path physically.
 *
 * @param {string} filename candidate filename
 * @returns {string|undefined} physical filename
 */
function getPhysicalPath (filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    return fs.realpathSync(filename)
  } catch {}
}

/**
 * Resolves one physical directory.
 *
 * @param {string} directory candidate directory
 * @returns {string|undefined} physical directory
 */
function getPhysicalDirectory (directory) {
  try {
    const physical = fs.realpathSync(directory)
    if (fs.statSync(physical).isDirectory()) return physical
  } catch {}
}

module.exports = { bindLiteralProject, supportsGeneratedFiles }
