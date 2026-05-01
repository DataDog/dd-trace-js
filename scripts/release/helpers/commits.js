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

/**
 * Parses a single line from `branch-diff --format=simple` output.
 * Returns null for lines that are not commit entries (e.g. headers, empty lines).
 *
 * Classification is driven entirely by the `(SEMVER-*)` markers that
 * `branch-diff` injects from a PR's `semver-*` labels. The
 * [pr-title.yml](../../../.github/workflows/pr-title.yml) workflow keeps the
 * label in sync with the conventional-commit type, so the title prefix is
 * not consulted here.
 *
 * `isReleasable` is true when the commit warrants a version bump on its own.
 * Commits without a `semver-*` label (e.g. `docs`, `chore`) ride along in the
 * release notes and the cherry-pick set, but should not on their own trigger
 * a release proposal.
 * @param {string} line
 * @returns {DiffEntry | null}
 */
function parseDiffLine (line) {
  // simple: * [abc1234567] - (SEMVER-MINOR) feat: subject (Author) https://github.com/.../pull/123
  const match = line.match(/^\* \[([0-9a-f]+)\] (.+)/)
  if (!match) return null
  const [, sha, rest] = match
  const isMajor = /SEMVER-MAJOR\b/.test(rest)
  const isMinor = !isMajor && /SEMVER-MINOR\b/.test(rest)
  const isPatch = !isMajor && !isMinor && /SEMVER-PATCH\b/.test(rest)
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
