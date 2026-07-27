'use strict'

const { environmentNamesEqual } = require('./environment')

const ASSIGNMENT_PATTERN =
  /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]*))(?:[ \t]+|$)/y

/**
 * Parses only complete literal environment assignments at the start of a command.
 *
 * @param {string} command command text
 * @returns {{assignments: Array<{name: string, source: string, value: string}>, length: number}} parsed prefix
 */
function parseLiteralEnvironmentPrefix (command) {
  const source = String(command || '')
  const assignments = []
  let offset = 0

  while (offset < source.length) {
    ASSIGNMENT_PATTERN.lastIndex = offset
    const match = ASSIGNMENT_PATTERN.exec(source)
    if (!match) break
    assignments.push({
      name: match[1],
      source: match[0].trimEnd(),
      value: match[2] ?? match[3] ?? match[4],
    })
    offset = ASSIGNMENT_PATTERN.lastIndex
  }

  return { assignments, length: offset }
}

/**
 * Removes complete leading assignments that explicitly clear one environment variable.
 *
 * @param {string} command command text
 * @param {string} name environment variable
 * @param {string} [platform] target platform
 * @returns {string} command without empty assignments
 */
function removeEmptyLiteralEnvironmentAssignments (command, name, platform = process.platform) {
  const source = String(command || '')
  const prefix = parseLiteralEnvironmentPrefix(source)
  const retained = prefix.assignments.filter(assignment => {
    return !environmentNamesEqual(assignment.name, name, platform) || assignment.value !== ''
  })
  if (retained.length === prefix.assignments.length) return source
  return [...retained.map(assignment => assignment.source), source.slice(prefix.length)]
    .filter(Boolean)
    .join(' ')
}

module.exports = {
  parseLiteralEnvironmentPrefix,
  removeEmptyLiteralEnvironmentAssignments,
}
