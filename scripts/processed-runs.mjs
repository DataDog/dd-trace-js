import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Sibling workflow run IDs whose Codecov upload already succeeded and whose junit/coverage
 * contributed to a successful Datadog batch upload in a previous All Green job attempt for this
 * commit (see all-green.yml's cache step). A rerun (e.g. retrying one flaky sibling workflow) can
 * skip redownloading artifacts and resubmitting uploads for these, instead of redoing every
 * sibling workflow from scratch.
 *
 * @param {string} path
 * @returns {Set<number>}
 */
export function loadProcessedRunIds (path) {
  if (!existsSync(path)) return new Set()
  return new Set(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * @param {string} path
 * @param {Set<number>} runIds
 * @returns {void}
 */
export function saveProcessedRunIds (path, runIds) {
  writeFileSync(path, JSON.stringify([...runIds].sort((a, b) => a - b)))
}
