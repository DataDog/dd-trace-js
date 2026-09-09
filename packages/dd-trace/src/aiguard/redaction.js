'use strict'

/** @typedef {import('../../../../index').aiguard.RedactionReplacement} RedactionReplacement */

const SEGMENT_PATTERN = /^([A-Za-z0-9_]+)(?:\[([0-9]+)\])?$/

/**
 * Converts the raw backend replacements into the public, typed contract.
 *
 * @param {unknown} replacements
 * @returns {RedactionReplacement[]}
 */
function normalizeRedactionReplacements (replacements) {
  if (!Array.isArray(replacements)) return []

  const result = []
  for (const entry of replacements) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue

    const { path, replacement } = entry
    if (typeof path !== 'string' || path.length === 0 || typeof replacement !== 'string') continue

    result.push({ path, replacement })
  }
  return result
}

/**
 * Parses an AI Guard location path into named segments and optional indexes.
 *
 * @param {string} path
 * @returns {Array<{ name: string, index: number|undefined }>|undefined}
 */
function parsePath (path) {
  const segments = []
  for (const rawSegment of path.split('.')) {
    const match = SEGMENT_PATTERN.exec(rawSegment)
    if (!match) return

    segments.push({
      name: match[1],
      index: match[2] === undefined ? undefined : Number(match[2]),
    })
  }
  return segments
}

/**
 * Reports whether a parsed path targets an allowed message string.
 *
 * @param {Array<{ name: string, index: number|undefined }>} segments
 * @returns {boolean}
 */
function isRedactablePath (segments) {
  const first = segments[0]
  if (first?.name !== 'messages' || first.index === undefined) return false

  if (segments.length === 2) {
    const content = segments[1]
    return content.name === 'content' && content.index === undefined
  }

  if (segments.length === 3) {
    const content = segments[1]
    const text = segments[2]
    return content.name === 'content' && content.index !== undefined &&
      text.name === 'text' && text.index === undefined
  }

  if (segments.length === 4) {
    const toolCalls = segments[1]
    const functionSegment = segments[2]
    const argumentsSegment = segments[3]
    return toolCalls.name === 'tool_calls' && toolCalls.index !== undefined &&
      functionSegment.name === 'function' && functionSegment.index === undefined &&
      argumentsSegment.name === 'arguments' && argumentsSegment.index === undefined
  }

  return false
}

/**
 * Resolves a location path to a writable string container and key.
 *
 * @param {{ messages: Array<object> }} root
 * @param {string} path
 * @returns {{ container: object|Array<unknown>, key: string|number }|undefined}
 */
function resolveWritableString (root, path) {
  const segments = parsePath(path)
  if (!segments || !isRedactablePath(segments)) return

  const terminal = segments.at(-1)
  let node = root
  for (let i = 0; i < segments.length - 1; i++) {
    const { name, index } = segments[i]
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, name)) return

    node = node[name]
    if (index !== undefined) {
      if (!Array.isArray(node) || index >= node.length) return
      node = node[index]
    }
  }

  if (!node || typeof node !== 'object') return
  if (!Object.hasOwn(node, terminal.name) || typeof node[terminal.name] !== 'string') return
  return { container: node, key: terminal.name }
}

/**
 * Applies redaction replacements to an AI Guard message list.
 * The caller transfers ownership of a private snapshot. Successful replacements mutate that snapshot in place.
 *
 * @param {Array<object>} messages
 * @param {unknown} replacements
 * @returns {{ messages: Array<object>, redacted: boolean, failures: number }}
 */
function redactMessages (messages, replacements) {
  if (!Array.isArray(messages) || replacements === undefined || replacements === null) {
    return { messages, redacted: false, failures: 0 }
  }

  try {
    if (!Array.isArray(replacements)) {
      return { messages, redacted: false, failures: 1 }
    }
    if (replacements.length === 0) return { messages, redacted: false, failures: 0 }

    const replacementsByPath = new Map()
    const conflictingPaths = new Set()
    let failures = 0
    for (const entry of replacements) {
      if (!entry || typeof entry !== 'object') {
        failures++
        continue
      }

      const { path, replacement } = entry
      if (typeof path !== 'string' || path.length === 0 || typeof replacement !== 'string') {
        failures++
        continue
      }

      if (conflictingPaths.has(path)) continue
      if (replacementsByPath.has(path) && replacementsByPath.get(path) !== replacement) {
        replacementsByPath.delete(path)
        conflictingPaths.add(path)
        failures++
        continue
      }
      replacementsByPath.set(path, replacement)
    }

    if (replacementsByPath.size === 0) return { messages, redacted: false, failures }

    const root = { messages }
    const targets = []

    for (const [path, replacement] of replacementsByPath) {
      const resolved = resolveWritableString(root, path)
      if (!resolved) {
        failures++
        continue
      }

      targets.push({ ...resolved, replacement })
    }

    for (const { container, key, replacement } of targets) {
      container[key] = replacement
    }

    return { messages, redacted: targets.length > 0, failures }
  } catch {
    return { messages, redacted: false, failures: 1 }
  }
}

module.exports = {
  normalizeRedactionReplacements,
  redactMessages,
}
