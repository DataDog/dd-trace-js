'use strict'

const { clean, coerce, intersects, subset } = require('semver')

const latests = require('./package.json').dependencies

const exactVersionExp = /^=?\d+\.\d+\.\d+/

// Packages whose published majors are not contiguous. `getVersionList()` must not auto-fill their in-between majors:
// the missing majors were never published, so installing them fails. A failing install of a multi-major range is the
// signal to add a package here (the install script's error points back to this list). New entries must explain the gap
// so the next reader does not "fix" it by removing the entry.
const nonConsecutiveMajorPackages = new Set([
  'graphql', // jumps from 0.x straight to 14.x (no 1.x–13.x); 14.x–17.x are covered via the apollo externals entries
  '@redis/client', // jumps from 2.x to 5.x (no 3.x–4.x)
])

/**
 * @param {string} name
 * @param {string} range
 */
function getCappedRange (name, range) {
  return range
    .split('||')
    .map(sub => capSubrange(name, sub.trim()))
    .join(' || ')
}

/**
 * @param {string} name
 * @param {string} subrange
 */
function capSubrange (name, subrange) {
  if (exactVersionExp.test(subrange)) return subrange

  if (!latests[name]) {
    throw new Error(
      `Latest version for '${name}' needs to be defined in 'packages/dd-trace/test/plugins/versions/package.json'.`
    )
  }

  if (!subrange || subrange === 'latest') return latests[name]
  if (subset(subrange, `<=${latests[name]}`)) return subrange
  if (subrange.includes(' - ')) {
    const minRange = subrange.split(' - ')[0].trim()

    return `${minRange} - ${latests[name]}`
  }

  return `${subrange} <=${latests[name]}`
}

/**
 * Expand a module's declared version entries into the de-duplicated set of version keys to install and test. Each key
 * maps to a `versions/<name>@<key>` workspace folder; the install script and `withVersions()` share this so the set of
 * installed folders and the set of tested folders never drift apart.
 *
 * Per range, this yields the lowest supported version (pinned exactly), the latest of every major in between, and the
 * range itself (which resolves to the newest supported version). The top major is derived from the pinned latest in
 * `package.json` rather than a registry lookup, so a major that does not exist makes the install fail loudly instead of
 * silently skipping versions — which is the signal to mark the range as non-consecutive (see `consecutiveMajors`).
 *
 * Notations that resolve to the same exact version (`1.2.3`, `=1.2.3`, `v1.2.3`) collapse to a single key, so a version
 * is never installed twice under different spellings.
 *
 * @param {string} name The module name, e.g. `mongodb`.
 * @param {string[]} versions The declared version entries, e.g. `['>=3.3 <5', '5', '>=6']`.
 * @param {Set<string>} [nonConsecutiveMajors] Module names whose majors are not contiguous; injectable for testing.
 * @returns {Array<{ versionKey: string, range: string }>} Ordered, de-duplicated entries. `versionKey` is the folder
 *   suffix; `range` is the declaring entry it came from.
 */
function getVersionList (name, versions, nonConsecutiveMajors = nonConsecutiveMajorPackages) {
  /** @type {Map<string, { versionKey: string, range: string }>} */
  const entries = new Map()

  const add = (versionKey, range) => {
    if (!entries.has(versionKey)) entries.set(versionKey, { versionKey, range })
  }

  for (const range of versions) {
    if (!range) continue

    if (range === '*') {
      add('*', range)
      continue
    }

    // Exact-version notations collapse to one key so the same version is never installed twice.
    const exact = clean(range)
    if (exact) {
      add(exact, range)
      continue
    }

    const floor = coerce(range)
    if (!floor) throw new Error(`Invalid version range for '${name}': ${range}`)

    add(floor.version, range)

    if (!nonConsecutiveMajors.has(name)) {
      const topMajor = highestMajor(name, range, floor.major)
      for (let major = floor.major + 1; major < topMajor; major++) {
        add(`>=${major}.0.0 <${major + 1}.0.0`, range)
      }
    }

    add(range, range)
  }

  return [...entries.values()]
}

/**
 * Highest major still spanned by `range`, capped at the pinned latest. Iterates down from the latest so the first
 * intersecting major is the top; nothing above the pinned latest is installed.
 *
 * @param {string} name
 * @param {string} range
 * @param {number} floorMajor
 * @returns {number}
 */
function highestMajor (name, range, floorMajor) {
  const latest = coerce(latests[name])
  if (!latest) return floorMajor
  for (let major = latest.major; major > floorMajor; major--) {
    if (intersects(`>=${major}.0.0 <${major + 1}.0.0`, range)) return major
  }
  return floorMajor
}

/**
 * Resolve which version keys to install and test for a module, plus which key the unversioned
 * `versions/<name>` folder points at. `scripts/install_plugin_modules.js` and `withVersions()` both call this so the
 * installed folder set and the tested folder set are derived from one place and cannot drift.
 *
 * @param {object} options
 * @param {string} options.name The module name, e.g. `fastify`.
 * @param {string[]} options.declaredVersions The declared version entries to expand.
 * @param {boolean} [options.honourEnvRange] Whether `PACKAGE_VERSION_RANGE` applies to this module. False for sibling
 *   externals that must stay on their declared versions while the matrix shards a different package.
 * @param {NodeJS.ProcessEnv} [options.env] Injectable for testing.
 * @returns {{ versionList: Array<{ versionKey: string, range: string }>, unversioned: string|undefined }} The ordered,
 *   `RANGE`-filtered key set, and the key the default `versions/<name>` folder resolves to (the newest in-scope entry,
 *   or `undefined` when nothing is in scope).
 */
function resolvePluginVersions ({ name, declaredVersions, honourEnvRange = true, env = process.env }) {
  const useEnvRange = Boolean(env.PACKAGE_VERSION_RANGE) && honourEnvRange
  const versions = useEnvRange ? [env.PACKAGE_VERSION_RANGE] : declaredVersions

  let versionList = getVersionList(name, versions)
  if (env.RANGE) {
    versionList = versionList.filter(({ versionKey }) => subset(versionKey, env.RANGE))
  }

  // With `PACKAGE_VERSION_RANGE` the shard itself is the target, so the unversioned folder keeps the raw range even
  // when `RANGE` narrows the installed keys; otherwise it follows the newest in-scope key.
  const unversioned = useEnvRange ? env.PACKAGE_VERSION_RANGE : versionList.at(-1)?.versionKey

  return { versionList, unversioned }
}

module.exports = {
  getCappedRange,
  getVersionList,
  resolvePluginVersions,
}
