/* eslint-disable no-console */

const semver = require('semver')
const {
  getInternals,
  npmView
} = require('./helpers/versioning')

function satisfiesAny (version, versions) {
  for (const ver of versions) {
    if (semver.satisfies(version, ver)) {
      return true
    }
  }
  return false
}

async function run () {
  const internals = consolidateInternals(getInternals())
  for (const inst in internals) {
    const distTags = await npmView(inst + ' dist-tags')
    const satisfied = satisfiesAny(distTags.latest, internals[inst])
    if (!satisfied) {
      console.log(
        `latest version of "${inst}" (${distTags.latest}) not supported in ranges: ${
          Array.from(internals[inst]).map(x => `"${x}"`).join(', ')
        }`
      )
      if (internals[inst].pinned) {
        console.log(`^----- "${inst}" pinned intentionally`)
      } else {
        process.exitCode = 1
      }
    }
  }
}

function consolidateInternals (internals) {
  const consolidated = {}
  for (const inst of internals) {
    if (Array.isArray(inst.name)) continue
    if (inst.name.startsWith('node:')) continue
    if (!inst.versions) continue
    if (!consolidated[inst.name] && inst.versions.length > 0) {
      consolidated[inst.name] = new Set(inst.versions)
    } else {
      for (const ver of inst.versions) {
        consolidated[inst.name].add(ver)
      }
    }
    if (inst.pinned) {
      consolidated[inst.name].pinned = true
    }
  }
  return consolidated
}

run()
