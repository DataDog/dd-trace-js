'use strict'

/* eslint-disable no-console */

// Registry-aware coverage check: for every package the plugin test matrix installs, ask the npm
// registry which majors are published and flag any that fall inside the declared support range but
// that no installed folder ever resolves to. It catches the silent drift where upstream ships a new
// major (or the pinned `latests` falls behind) and the matrix keeps testing the old set. Run nightly
// rather than per-PR: it is network-bound and its result changes when upstream publishes, not when we
// push.

const fs = require('fs')
const { builtinModules } = require('module')
const path = require('path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const { getVersionList } = require('../packages/dd-trace/test/plugins/versions')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const externals = require('../packages/dd-trace/test/plugins/externals')
const mapWithConcurrency = require('./helpers/concurrency')

const REGISTRY = 'https://registry.npmjs.org'
const CONCURRENCY = 12
const builtins = new Set(builtinModules)

/**
 * Collect the declared version ranges for every npm package the matrix installs, merging the
 * `addHook` declarations (the source of truth for supported versions) with the auxiliary anchors
 * declared in externals.js.
 *
 * @returns {Map<string, Set<string>>} Package name to the set of declared ranges.
 */
function collectDeclaredVersions () {
  const declared = new Map()
  /**
   * @param {string} name
   * @param {string[]|undefined} versions
   */
  const addRanges = (name, versions) => {
    if (!versions) return
    const ranges = declared.get(name) ?? new Set()
    for (const range of versions) {
      if (range) ranges.add(range)
    }
    declared.set(name, ranges)
  }

  const instrumentationsDir = path.join(__dirname, '../packages/datadog-instrumentations/src')
  for (const file of fs.readdirSync(instrumentationsDir)) {
    if (!file.endsWith('.js')) continue
    let instrumentations
    try {
      instrumentations = getInstrumentation(file.slice(0, -3))
    } catch {
      continue
    }
    for (const instrumentation of instrumentations) {
      addRanges(instrumentation.name, instrumentation.versions)
    }
  }

  for (const name of Object.keys(externals)) {
    for (const entry of externals[name]) {
      addRanges(entry.name, entry.versions)
    }
  }

  return declared
}

/**
 * Fetch the published, non-prerelease versions of an npm package.
 *
 * @param {string} name
 * @returns {Promise<string[]|undefined>} The versions, or `undefined` when the package is not on the registry.
 */
async function fetchPublishedVersions (name) {
  const response = await fetch(`${REGISTRY}/${name.replaceAll('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`registry responded ${response.status}`)
  const body = await response.json()
  return Object.keys(body.versions ?? {}).filter(version => !semver.prerelease(version))
}

/**
 * Compare the declared range against the majors the matrix actually resolves to, and report the
 * published majors that sit inside the declared range but that no installed folder covers.
 *
 * @param {string} name
 * @param {Set<string>} ranges
 * @param {string[]} published
 * @returns {{ supportedRange: string, testedMajors: number[], untestedMajors: number[] }}
 */
function analyzeCoverage (name, ranges, published) {
  const declaredVersions = [...ranges]
  const supportedRange = declaredVersions.join(' || ')

  const testedMajors = new Set()
  for (const { versionKey } of getVersionList(name, declaredVersions)) {
    const resolved = semver.maxSatisfying(published, versionKey)
    if (resolved) testedMajors.add(semver.major(resolved))
  }

  const untestedMajors = new Set()
  for (const version of published) {
    const major = semver.major(version)
    if (!testedMajors.has(major) && semver.satisfies(version, supportedRange)) {
      untestedMajors.add(major)
    }
  }

  return {
    supportedRange,
    testedMajors: [...testedMajors].sort((first, second) => first - second),
    untestedMajors: [...untestedMajors].sort((first, second) => first - second),
  }
}

async function main () {
  const declared = [...collectDeclaredVersions()].filter(([name]) => !builtins.has(name))

  const results = await mapWithConcurrency(declared, CONCURRENCY, async ([name, ranges]) => {
    try {
      const published = await fetchPublishedVersions(name)
      if (!published?.length) return { name, skipped: true }
      return { name, ...analyzeCoverage(name, ranges, published) }
    } catch (error) {
      return { name, error: error.message }
    }
  })

  const gaps = []
  const errors = []
  const skipped = []
  for (const result of results) {
    if (result.error) errors.push(result)
    else if (result.skipped) skipped.push(result)
    else if (result.untestedMajors?.length) gaps.push(result)
  }

  for (const { name, supportedRange, testedMajors, untestedMajors } of gaps) {
    console.log(
      `${name}: published major(s) ${untestedMajors.join(', ')} are within the declared range ` +
      `"${supportedRange}" but the matrix only resolves majors ${testedMajors.join(', ')}`
    )
  }

  if (errors.length) {
    console.log(`\nCould not reach the registry for ${errors.length} package(s):`)
    for (const { name, error } of errors) {
      console.log(`  ${name}: ${error}`)
    }
  }

  if (skipped.length) {
    console.log(`\nNot on the public registry, skipped: ${skipped.map(({ name }) => name).join(', ')}`)
  }

  console.log(`\nChecked ${declared.length} packages (${skipped.length} not on the public registry, ` +
    `${errors.length} errored).`)

  if (gaps.length) {
    console.log(
      `\n${gaps.length} package(s) publish a supported major the test matrix never resolves to. ` +
      'Cover the major (bump the pinned latest or add the range), or cap the addHook range if the major is ' +
      'intentionally unsupported.'
    )
    process.exitCode = 1
  } else {
    console.log('\nEvery published major within the declared ranges is covered by the test matrix.')
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
