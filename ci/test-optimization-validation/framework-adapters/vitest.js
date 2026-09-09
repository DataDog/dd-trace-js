'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { matchesLiteralGlob } = require('../literal-glob')
const { maskJavaScriptComments, maskJavaScriptNonCode } = require('../source-text')

const CONFIG_PATTERN = /^(?:vite\.config|vitest\.(?:config|workspace))\.[cm]?[jt]s$/
const WORKSPACE_CONFIG_PATTERN = /^vitest\.workspace\.[cm]?[jt]s$/
const DIRECT_EXPORT_PATTERN = /(?:export\s+default|module\s*\.\s*exports\s*=)\s*$/
const CONFIG_CALL_PATTERN =
  /(?:export\s+default|module\s*\.\s*exports\s*=)\s*defineConfig\s*\(\s*$/
const WORKSPACE_ARRAY_CALL_PATTERN =
  /(?:export\s+default|module\s*\.\s*exports\s*=)\s*defineWorkspace\s*\(\s*$/
const PROJECT_CALL_PATTERN =
  /(?:export\s+default|module\s*\.\s*exports\s*=)\s*defineProject\s*\(\s*$/
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
 *   excludePatterns?: string[],
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
  const roots = getOptionValues(runnerArgs, '--root')
  if (roots.length > 1) {
    return { error: '--project cannot be bound with more than one Vitest root' }
  }
  const effectiveRoot = roots.length === 1
    ? getPhysicalDirectory(path.resolve(projectRoot, roots[0]))
    : getPhysicalDirectory(projectRoot)
  if (!effectiveRoot || !isContainedDirectory(projectRoot, effectiveRoot)) {
    return { error: 'the selected Vitest root is not a project-contained directory' }
  }

  const selectedConfigs = getSelectedConfigFiles({ configFiles, effectiveRoot, projectRoot, runnerArgs })
  if (selectedConfigs.error) return selectedConfigs
  const bindings = []
  for (const configFile of selectedConfigs.files) {
    const source = readText(configFile)
    if (source === undefined) continue
    for (const property of getLiteralStringProperties(source, 'name')) {
      if (property.value !== name) continue
      const project = getProjectObject(
        source,
        property.index,
        WORKSPACE_CONFIG_PATTERN.test(path.basename(configFile))
      )
      if (!project) continue
      const projectName = getLiteralProperty(project.source, 'name')
      if (projectName.dynamic || projectName.value !== name) continue
      const binding = getBindingFromObject({
        bindingRoot: effectiveRoot,
        configFile,
        projectFiles,
        projectEntry: project.entrySource,
        projectObject: project.source,
        projectRoot,
        standaloneProject: project.standalone,
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

function getSelectedConfigFiles ({ configFiles, effectiveRoot, projectRoot, runnerArgs }) {
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

  return {
    files: configFiles.filter(filename => {
      return path.dirname(filename) === effectiveRoot && CONFIG_PATTERN.test(path.basename(filename))
    }),
  }
}

function getBindingFromObject ({
  bindingRoot,
  configFile,
  projectFiles,
  projectEntry,
  projectObject,
  projectRoot,
  standaloneProject,
}) {
  if (/\.\.\./.test(maskJavaScriptNonCode(projectEntry))) {
    return { error: 'the selected Vitest project uses dynamic spread composition' }
  }

  const rootProperty = getLiteralProperty(projectObject, 'root')
  if (rootProperty.dynamic) return { error: 'the selected Vitest project has a dynamic root' }

  const rootBase = standaloneProject ? path.dirname(configFile) : bindingRoot
  const root = rootProperty.value
    ? path.resolve(rootBase, rootProperty.value)
    : standaloneProject
      ? path.dirname(configFile)
      : bindingRoot
  if (!isContainedDirectory(projectRoot, root)) {
    return { error: 'the selected Vitest project root is not a repository-contained directory' }
  }

  const include = getLiteralStringArray(projectObject, 'include')
  if (include.dynamic) return { error: 'the selected Vitest project has dynamic include patterns' }
  const exclude = getLiteralStringArray(projectObject, 'exclude')
  if (exclude.dynamic) return { error: 'the selected Vitest project has dynamic exclude patterns' }
  const project = {
    excludePatterns: exclude.values,
    includePatterns: include.values,
    root,
  }
  const files = projectFiles.filter(filename => matchesProjectFile(project, filename))
  return { configFile, files, ...project }
}

function supportsGeneratedFiles (project, strategy) {
  return strategy.scenarios.every(scenario => {
    return matchesProjectFile(project, scenario.testIdentities[0].file)
  })
}

function matchesProjectFile (project, filename) {
  const relative = path.relative(project.root, filename)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
  const normalized = relative.replaceAll('\\', '/')
  const included = project.includePatterns.length === 0 ||
    project.includePatterns.some(pattern => matchesLiteralGlob(normalized, pattern))
  return included && !project.excludePatterns.some(pattern => matchesLiteralGlob(normalized, pattern))
}

/**
 * Returns the literal project object that owns a matching name property.
 *
 * @param {string} source Vitest configuration source
 * @param {number} nameIndex matching name property offset
 * @param {boolean} workspaceConfig whether the source is a Vitest workspace config
 * @returns {{entrySource: string, source: string, standalone: boolean}|undefined} bounded project object
 */
function getProjectObject (source, nameIndex, workspaceConfig) {
  const objectRanges = getObjectRanges(source)
  const ranges = objectRanges
    .filter(range => range.start < nameIndex && range.end > nameIndex)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
  if (ranges.length === 0) return

  // Vitest accepts both `{ name }` and `{ test: { name } }` project entries.
  const inner = ranges[0]
  const parent = ranges[1]
  const parentPrefix = parent && maskJavaScriptComments(source.slice(parent.start + 1, inner.start))
  const nestedTestObject = /(?:^|,)\s*(?:test|(["'])test\1)\s*:\s*$/.test(parentPrefix || '')
  if (nestedTestObject &&
    getDirectPropertyPositions(source.slice(parent.start + 1, parent.end), 'test').length !== 1) return
  const selected = nestedTestObject ? parent : inner
  const standalone = isStandaloneProjectObject(source, selected)
  if (!standalone &&
    !isTestProjectsEntry(source, selected, objectRanges) &&
    !(workspaceConfig && isWorkspaceProjectEntry(source, selected))) return
  return {
    entrySource: source.slice(selected.start + 1, selected.end),
    source: source.slice(inner.start + 1, inner.end),
    standalone,
  }
}

/**
 * Reports whether an object is the direct literal argument to defineProject.
 *
 * @param {string} source Vitest configuration source
 * @param {{end: number, start: number}} range candidate object range
 * @returns {boolean} whether the object is a standalone project
 */
function isStandaloneProjectObject (source, range) {
  const before = maskJavaScriptNonCode(source.slice(0, range.start))
  const after = maskJavaScriptNonCode(source.slice(range.end + 1))
  return PROJECT_CALL_PATTERN.test(before) && /^\s*(?:,\s*)?\)[\s;]*$/.test(after)
}

/**
 * Reports whether an object is a direct entry in a literal test.projects array.
 *
 * @param {string} source Vitest configuration source
 * @param {{end: number, start: number}} range candidate object range
 * @param {{end: number, start: number}[]} objectRanges source object ranges
 * @returns {boolean} whether the object is a bounded project entry
 */
function isTestProjectsEntry (source, range, objectRanges) {
  const projectsArray = getDirectContainingArray(source, range)
  if (!projectsArray) return false

  const containers = objectRanges
    .filter(object => object.start < projectsArray.start && object.end > projectsArray.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
  const testObject = containers[0]
  const configObject = containers[1]
  if (!testObject || !configObject) return false

  const projectsPrefix = maskJavaScriptComments(source.slice(testObject.start + 1, projectsArray.start))
  if (!/(?:^|,)\s*(?:projects|"projects"|'projects')\s*:\s*$/.test(projectsPrefix) ||
    getDirectPropertyPositions(
      source.slice(testObject.start + 1, testObject.end),
      'projects'
    ).length !== 1) return false

  const testPrefix = maskJavaScriptComments(source.slice(configObject.start + 1, testObject.start))
  return /(?:^|,)\s*(?:test|"test"|'test')\s*:\s*$/.test(testPrefix) &&
    getDirectPropertyPositions(source.slice(configObject.start + 1, configObject.end), 'test').length === 1 &&
    isExportedConfigObject(source, configObject)
}

/**
 * Reports whether an object is the direct exported config or defineConfig argument.
 *
 * @param {string} source Vitest configuration source
 * @param {{end: number, start: number}} range candidate config object range
 * @returns {boolean} whether the object belongs to the exported configuration
 */
function isExportedConfigObject (source, range) {
  const before = maskJavaScriptNonCode(source.slice(0, range.start))
  const after = maskJavaScriptNonCode(source.slice(range.end + 1))
  return (DIRECT_EXPORT_PATTERN.test(before) && /^[\s;]*$/.test(after)) ||
    (CONFIG_CALL_PATTERN.test(before) && /^\s*(?:,\s*)?\)[\s;]*$/.test(after))
}

/**
 * Reports whether an object is a direct entry in the exported array of a Vitest workspace config.
 *
 * @param {string} source Vitest workspace configuration source
 * @param {{end: number, start: number}} range candidate object range
 * @returns {boolean} whether the object is a bounded workspace project entry
 */
function isWorkspaceProjectEntry (source, range) {
  const workspaceArray = getDirectContainingArray(source, range)
  if (!workspaceArray) return false

  const before = maskJavaScriptNonCode(source.slice(0, workspaceArray.start))
  const after = maskJavaScriptNonCode(source.slice(workspaceArray.end + 1))
  return (DIRECT_EXPORT_PATTERN.test(before) && /^[\s;]*$/.test(after)) ||
    (WORKSPACE_ARRAY_CALL_PATTERN.test(before) && /^\s*(?:,\s*)?\)[\s;]*$/.test(after))
}

/**
 * Returns the smallest array containing an object as a direct entry.
 *
 * @param {string} source JavaScript-like source
 * @param {{end: number, start: number}} range candidate object range
 * @returns {{end: number, start: number}|undefined} containing direct array
 */
function getDirectContainingArray (source, range) {
  const arrays = getDelimitedRanges(source, '[', ']')
    .filter(array => array.start < range.start && array.end > range.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
  const directArray = arrays[0]
  if (!directArray) return

  const entryPrefix = maskJavaScriptComments(source.slice(directArray.start, range.start)).trimEnd()
  const entrySuffix = maskJavaScriptComments(source.slice(range.end + 1, directArray.end + 1)).trimStart()
  if (['[', ','].includes(entryPrefix.at(-1)) && [']', ','].includes(entrySuffix[0])) return directArray
  if (/(?:^|\[|,)\s*defineProject\s*\(\s*$/.test(entryPrefix) && /^,?\s*\)\s*[\],]/.test(entrySuffix)) {
    return directArray
  }
}

/**
 * Finds balanced object ranges while ignoring comments and strings.
 *
 * @param {string} source JavaScript-like source
 * @returns {{end: number, start: number}[]} object ranges
 */
function getObjectRanges (source) {
  return getDelimitedRanges(source, '{', '}')
}

/**
 * Finds balanced delimiter ranges while ignoring comments and strings.
 *
 * @param {string} source JavaScript-like source
 * @param {string} open opening delimiter
 * @param {string} close closing delimiter
 * @returns {{end: number, start: number}[]} delimiter ranges
 */
function getDelimitedRanges (source, open, close) {
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
    } else if (character === open) {
      stack.push(index)
    } else if (character === close) {
      const start = stack.pop()
      if (start !== undefined) ranges.push({ end: index, start })
    }
  }
  return ranges
}

function getLiteralStringProperties (source, property) {
  return getPropertyPositions(source, property).flatMap(({ index, valueStart }) => {
    const literal = /^(["'])([^"'\\]+)\1/.exec(source.slice(valueStart))
    return literal ? [{ index, value: literal[2] }] : []
  })
}

function getPropertyPositions (source, property) {
  const properties = []
  let quote
  let lineComment = false
  let blockComment = false
  let previousCodeCharacter = '{'
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
      const match = new RegExp(String.raw`^(["'])${property}\1\s*:\s*`).exec(source.slice(index))
      if (match && ['{', ','].includes(previousCodeCharacter)) {
        properties.push({ index, valueStart: index + match[0].length })
        previousCodeCharacter = ':'
        index += match[0].length - 1
        continue
      }
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

    const match = new RegExp(String.raw`^${property}\s*:\s*`).exec(source.slice(index))
    if (!match) {
      previousCodeCharacter = character
      continue
    }
    properties.push({ index, valueStart: index + match[0].length })
    previousCodeCharacter = ':'
    index += match[0].length - 1
  }
  return properties
}

function getLiteralProperty (source, property) {
  const properties = getDirectPropertyPositions(source, property)
  if (properties.length === 0) return {}
  if (properties.length !== 1) return { dynamic: true }
  const literal = /^(["'])([^"'\\]+)\1/.exec(source.slice(properties[0].valueStart))
  if (literal) return { value: literal[2] }
  return { dynamic: true }
}

function getLiteralStringArray (source, property) {
  const properties = getDirectPropertyPositions(source, property)
  if (properties.length === 0) return { values: [] }
  if (properties.length !== 1) return { dynamic: true, values: [] }
  const arrayMatch = /^\[([\s\S]{0,8192}?)\]/.exec(source.slice(properties[0].valueStart))
  if (!arrayMatch) return { dynamic: true, values: [] }
  const syntax = maskJavaScriptComments(arrayMatch[1])
  const values = [...syntax.matchAll(/(["'])([^"'\\]+)\1/g)].map(match => match[2])
  const residue = syntax.replaceAll(/(["'])([^"'\\]+)\1/g, '').replaceAll(',', '').trim()
  return residue ? { dynamic: true, values: [] } : { values }
}

/**
 * Returns matching properties that are not nested inside another object.
 *
 * @param {string} source JavaScript object contents
 * @param {string} property property name
 * @returns {{index: number, valueStart: number}[]} direct property positions
 */
function getDirectPropertyPositions (source, property) {
  const nestedObjects = getObjectRanges(source)
  return getPropertyPositions(source, property).filter(position => {
    return !nestedObjects.some(object => object.start < position.index && object.end > position.index)
  })
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

function getPhysicalPath (filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    return fs.realpathSync(filename)
  } catch {}
}

function getPhysicalDirectory (directory) {
  try {
    const physical = fs.realpathSync(directory)
    if (fs.statSync(physical).isDirectory()) return physical
  } catch {}
}

module.exports = { bindLiteralProject, supportsGeneratedFiles }
