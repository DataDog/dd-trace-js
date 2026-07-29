'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { matchesLiteralGlob } = require('../literal-glob')

const CONFIG_PATTERN = /^(?:vite\.config|vitest\.(?:config|workspace))\.[cm]?[jt]s$/
const PROJECT_NAME_PATTERN = /\bname\s*:\s*(["'])([^"'\\]+)\1/g
const LITERAL_PROJECT_PATTERN = /^[A-Za-z0-9_.:@/-]+$/

/**
 * Binds one literal `--project` selector to one statically named Vitest project.
 *
 * Customer configuration is read as text only. Dynamic names, roots, includes, and ambiguous matches fail closed.
 *
 * @param {object} input project inputs
 * @param {string[]} input.projectFiles bounded project files
 * @param {string} input.projectRoot detected project root
 * @param {string[]} input.runnerArgs retained Vitest arguments
 * @returns {{configFile?: string, error?: string, files?: string[], root?: string}|undefined} project binding
 */
function bindLiteralProject ({ projectFiles, projectRoot, runnerArgs }) {
  const projects = getOptionValues(runnerArgs, '--project')
  if (projects.length === 0) return
  if (projects.length !== 1 || !LITERAL_PROJECT_PATTERN.test(projects[0])) {
    return { error: '--project must select exactly one literal project name' }
  }

  const name = projects[0]
  const bindings = []
  for (const configFile of projectFiles) {
    if (!CONFIG_PATTERN.test(path.basename(configFile))) continue
    const source = readText(configFile)
    if (source === undefined) continue
    for (const match of source.matchAll(PROJECT_NAME_PATTERN)) {
      if (match[2] !== name) continue
      const projectObject = getProjectObject(source, match.index)
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
  return { configFile, files, root }
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

module.exports = { bindLiteralProject }
