'use strict'

/**
 * @typedef {{ sha: string, isMajor: boolean, isMinor: boolean, line: string }} DiffEntry
 */

/**
 * Parses a single line from branch-diff --format=simple or --format=markdown output.
 * Returns null for lines that are not commit entries (e.g. headers, empty lines).
 * @param {string} line
 * @returns {DiffEntry | null}
 */
function parseDiffLine (line) {
  // simple:   * [abc1234567] feat: subject (Author) [#123] [SEMVER-MINOR]
  // markdown: * [[`abc1234567`](url)] - feat: subject (Author) [#123] [SEMVER-MINOR]
  const match = line.match(/^\* \[(?:\[`?)?([0-9a-f]+)(?:`?\]\([^)]+\))?\] (?:- )?(.+)/)
  if (!match) return null
  const [, sha, rest] = match
  const isMajor = rest.includes('[SEMVER-MAJOR]') || /^[a-z]+(?:\([^)]+\))?!:/.test(rest)
  const isMinor = !isMajor && (rest.includes('[SEMVER-MINOR]') || /^feat(?:\(|:)/.test(rest))
  return { sha, isMajor, isMinor, line }
}

module.exports = { parseDiffLine }
