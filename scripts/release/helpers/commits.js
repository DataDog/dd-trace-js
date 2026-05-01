'use strict'

/**
 * @typedef {{
 *   sha: string,
 *   isMajor: boolean,
 *   isMinor: boolean,
 *   isPatch: boolean,
 *   isReleasable: boolean,
 *   line: string,
 * }} DiffEntry
 */

const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'revert'])

/**
 * Parses a single line from `branch-diff --format=simple` output.
 * Returns null for lines that are not commit entries (e.g. headers, empty lines).
 *
 * `isReleasable` is true when the commit warrants a version bump on its own.
 * Commits with non-releasing types (e.g. `docs`, `chore`) ride along in the
 * release notes and the cherry-pick set, but should not on their own trigger
 * a release proposal.
 * @param {string} line
 * @returns {DiffEntry | null}
 */
function parseDiffLine (line) {
  // simple: * [abc1234567] feat: subject (Author) [#123] [SEMVER-MINOR]
  const match = line.match(/^\* \[([0-9a-f]+)\] (.+)/)
  if (!match) return null
  const [, sha, rest] = match
  const typeMatch = rest.match(/^([a-z]+)(?:\([^)]+\))?(!)?:/)
  const type = typeMatch?.[1]
  const isMajor = rest.includes('[SEMVER-MAJOR]') || typeMatch?.[2] === '!'
  const isMinor = !isMajor && (rest.includes('[SEMVER-MINOR]') || type === 'feat')
  const isPatch = !isMajor && !isMinor && PATCH_TYPES.has(type)
  const isReleasable = isMajor || isMinor || isPatch
  return { sha, isMajor, isMinor, isPatch, isReleasable, line }
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
