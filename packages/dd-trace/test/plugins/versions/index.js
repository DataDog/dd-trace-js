'use strict'

const { clean, coerce, intersects, satisfies, subset } = require('semver')

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
 * Per declared range this yields the lowest supported version (pinned exactly) and the newest version of every major
 * the range spans, keyed by the bare major so the key resolves to that major's latest. Covering each major explicitly
 * (rather than emitting the raw range, which resolves only to the newest version of the whole range) makes sure the
 * floor major's latest is tested too. The top major is derived from the pinned latest in `package.json` rather than a
 * registry lookup, so a major that was never published makes the install fail loudly — the signal to add the package
 * to `nonConsecutiveMajorPackages`.
 *
 * A bare-major key resolves to that major's newest published version, so it can only be used where the declared range
 * spans the major in full. When the range caps inside its top major (an upper bound below `<${major + 1}.0.0`), the
 * top major keeps the declared range instead, which resolves to the newest version the range still allows — a bare
 * key there would overshoot the ceiling (`>=2.1 <=3.0.0` keyed `3` installs the major's latest, a version above the
 * declared `<=3.0.0` that the plugin never supported).
 *
 * Notations that resolve to the same exact version (`1.2.3`, `=1.2.3`, `v1.2.3`) collapse to a single key, and `*`
 * collapses to the latest major (the same version an open-ended range resolves to), so a version is never installed
 * twice under different spellings. A floor that equals the pinned latest also drops the redundant top-major key,
 * since the pinned `package.json` proves they resolve to the same version.
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
    // An empty entry is a setup mistake (a stray comma or an undefined slot); fail loudly rather than skip silently.
    if (!range) {
      throw new Error(`Empty version entry declared for '${name}'. Each declared version must be a non-empty range.`)
    }

    if (range === '*') {
      add(latestMajor(name), range)
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

    const topMajor = highestMajor(name, range, floor.major)

    const addMajor = (major) => {
      if (!intersects(`>=${major}.0.0 <${major + 1}.0.0`, range)) return
      // The top major is the only one the range can cap inside; lower majors are always spanned in full. A capped top
      // keeps the declared range so it resolves below the ceiling instead of jumping to the major's latest.
      if (major === topMajor && !reachesMajorCeiling(major, range)) {
        add(range, range)
      } else {
        add(String(major), range)
      }
    }

    if (nonConsecutiveMajors.has(name)) {
      // Only the in-between majors were never published. The floor major and the top major both exist, so add the
      // latest of each (skipping the uncertain middle, which is what would make the install fail).
      addMajor(floor.major)
      if (topMajor > floor.major) addMajor(topMajor)
    } else {
      for (let major = floor.major; major <= topMajor; major++) {
        addMajor(major)
      }
    }
  }

  // The bare-major key for the pinned latest's major resolves to the pin itself, so when a declared floor already pins
  // that exact version the major key would install the same thing. Drop it. This is the only such redundancy the
  // pinned upper bound lets us prove; for lower majors the newest published version is unknown without the registry.
  const pinned = coerce(latests[name])
  if (pinned && entries.has(pinned.version)) entries.delete(String(pinned.major))

  return [...entries.values()]
}

// Higher than any real release within a major. A range that still admits it does not cap inside the major, so a
// bare-major key is safe; a range that excludes it ends mid-major and must keep its own upper bound.
const MAJOR_CEILING_PROBE = 999_999

/**
 * Whether `range` admits versions all the way to the top of `major` (a clean `<${major + 1}.0.0` upper bound, or none).
 * When it does not, a bare-major key would resolve past the declared ceiling, so the caller keeps the declared range.
 *
 * @param {number} major
 * @param {string} range
 * @returns {boolean}
 */
function reachesMajorCeiling (major, range) {
  return satisfies(`${major}.${MAJOR_CEILING_PROBE}.${MAJOR_CEILING_PROBE}`, range)
}

/**
 * The latest major of `name` as a bare-major version key. `*` resolves here so it de-duplicates against an open-ended
 * range whose top resolves to the same newest version.
 *
 * @param {string} name
 * @returns {string}
 */
function latestMajor (name) {
  const latest = coerce(latests[name])
  if (!latest) {
    throw new Error(
      `Latest version for '${name}' needs to be defined in 'packages/dd-trace/test/plugins/versions/package.json'.`
    )
  }
  return String(latest.major)
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
