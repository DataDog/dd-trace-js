'use strict'

/**
 * @typedef {{ sha: string, isMajor: boolean, isMinor: boolean, line: string }} DiffEntry
 */

/**
 * Parses a single line from `branch-diff --format=simple` output.
 * Returns null for lines that are not commit entries (e.g. headers, empty lines).
 * @param {string} line
 * @returns {DiffEntry | null}
 */
function parseDiffLine (line) {
  // simple: * [abc1234567] feat: subject (Author) [#123] [SEMVER-MINOR]
  const match = line.match(/^\* \[([0-9a-f]+)\] (.+)/)
  if (!match) return null
  const [, sha, rest] = match
  const isMajor = rest.includes('[SEMVER-MAJOR]') || /^[a-z]+(?:\([^)]+\))?!:/.test(rest)
  const isMinor = !isMajor && (rest.includes('[SEMVER-MINOR]') || /^feat(?:\(|:)/.test(rest))
  return { sha, isMajor, isMinor, line }
}

/**
 * Extracts the commit SHA from any branch-diff output line.
 * The SHA is always the first hex run in the line for both `--format=simple`
 * and `--format=markdown` outputs. Returns null if no SHA is found.
 * @param {string} line
 * @returns {string | null}
 */
function extractSha (line) {
  const match = line.match(/[0-9a-f]{7,}/)
  return match ? match[0] : null
}

module.exports = { parseDiffLine, extractSha }
