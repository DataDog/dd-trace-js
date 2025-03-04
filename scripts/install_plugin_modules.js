'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const semver = require('semver')
const exec = require('./helpers/exec')
const childProcess = require('child_process')
const externals = require('../packages/dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const latests = require('../packages/datadog-instrumentations/src/helpers/latests.json')

const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase <= 3.2.0
const excludeList = os.arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
const versionLists = {}
const deps = {}
const filter = process.env.hasOwnProperty('PLUGINS') && process.env.PLUGINS.split('|')

Object.keys(externals).forEach(external => externals[external].forEach(thing => {
  if (thing.dep) {
    if (!deps[external]) {
      deps[external] = []
    }
    deps[external].push(thing.name)
  }
}))

const names = fs.readdirSync(path.join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  .filter(file => file.endsWith('.js'))
  .map(file => file.slice(0, -3))
  .filter(file => !filter || filter.includes(file))

run()

async function run () {
  assertFolder()
  await assertVersions()
  assertWorkspace()
  // Some native addon packages rely on libraries that are not supported on ARM64
  excludeList.forEach(pkg => delete workspaces[pkg])
  install()
}

async function assertVersions () {
  const internals = names
    .map(getInstrumentation)
    .reduce((prev, next) => prev.concat(next), [])

  for (const inst of internals) {
    await assertInstrumentation(inst, false)
  }

  const externalNames = Object.keys(externals).filter(name => ~names.indexOf(name))
  for (const name of externalNames) {
    for (const inst of [].concat(externals[name])) {
      await assertInstrumentation(inst, true)
    }
  }
}

async function assertInstrumentation (instrumentation, external) {
  const versions = process.env.PACKAGE_VERSION_RANGE && !external
    ? [process.env.PACKAGE_VERSION_RANGE]
    : [].concat(instrumentation.versions || [])

  for (const version of versions) {
    if (version) {
      if (version !== '*') {
        await assertModules(instrumentation.name, semver.coerce(version).version, external)
      }

      await assertModules(instrumentation.name, version, external)
    }
  }
}

async function assertModules (name, version, external) {
  const range = process.env.RANGE
  if (range && !semver.subset(version, range)) return
  addFolder(name)
  addFolder(name, version)
  assertFolder(name)
  assertFolder(name, version)
  await assertPackage(name, null, version, external)
  await assertPackage(name, version, version, external)
  assertIndex(name)
  assertIndex(name, version)
}

function assertFolder (name, version) {
  if (!fs.existsSync(folder())) {
    fs.mkdirSync(folder())
  }

  if (name && name.includes(path.sep)) {
    name.split(path.sep).reduce(parent => assertFolder(parent))
  }

  if (!fs.existsSync(folder(name, version))) {
    fs.mkdirSync(folder(name, version))
  }
}

// Helper function to apply version caps in a more readable way
function applyCap (versionRange, latestVersion) {
  // Handle caret ranges (e.g., "^3.0.7")
  const caretRangeMatch = versionRange.match(/^\^(\d+\.\d+\.\d+)(.*)$/)
  if (caretRangeMatch) {
    return handleCaretRange(caretRangeMatch, latestVersion)
  }

  // Handle hyphen ranges (e.g., "24.8.0 - 24.9.0")
  const hyphenRangeMatch = versionRange.match(/^(\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+)(.*)$/)
  if (hyphenRangeMatch) {
    return handleHyphenRange(hyphenRangeMatch, latestVersion)
  }

  // Handle exact versions (e.g., "24.8.0")
  if (semver.valid(versionRange)) {
    return handleExactVersion(versionRange, latestVersion)
  }

  // Handle other valid semver ranges
  if (semver.validRange(versionRange)) {
    return handleValidRange(versionRange, latestVersion)
  }

  // If nothing else matched, return the original range
  return versionRange
}

// Handle caret ranges like "^3.0.7"
function handleCaretRange (match, latestVersion) {
  const [, version, extraConstraints] = match
  const parsed = semver.parse(version)

  // Calculate the upper bound implied by caret notation
  let upperBound
  if (parsed.major === 0) {
    if (parsed.minor === 0) {
      // ^0.0.x -> <0.0.(x+1)
      upperBound = `0.0.${parsed.patch + 1}`
    } else {
      // ^0.y.x -> <0.(y+1).0
      upperBound = `0.${parsed.minor + 1}.0`
    }
  } else {
    // ^x.y.z -> <(x+1).0.0
    upperBound = `${parsed.major + 1}.0.0`
  }

  // Cap at the lower of: original caret upper bound or latest version
  const effectiveLatest = semver.lt(upperBound, latestVersion) ? upperBound : latestVersion

  // Create properly formatted range that preserves caret semantics
  let result = `>=${version} <${effectiveLatest}`

  // Add any extra constraints if they exist and would create a valid range
  if (extraConstraints && extraConstraints.trim()) {
    const combinedRange = `${result} ${extraConstraints.trim()}`
    if (semver.validRange(combinedRange)) {
      result = combinedRange
    }
  }

  return result
}

// Handle hyphen ranges like "24.8.0 - 24.9.0"
function handleHyphenRange (match, latestVersion) {
  const [, lowerBound, upperBound, extraConstraints] = match

  // Cap at the lower of: original upper bound or latest version
  const effectiveUpper = semver.lt(upperBound, latestVersion) ? upperBound : latestVersion

  // Create properly formatted range
  let result = `>=${lowerBound} <=${effectiveUpper}`

  // Add any extra constraints if they exist and would create a valid range
  if (extraConstraints && extraConstraints.trim()) {
    const combinedRange = `${result} ${extraConstraints.trim()}`
    if (semver.validRange(combinedRange)) {
      result = combinedRange
    }
  }

  return result
}

// Handle exact versions like "24.8.0"
function handleExactVersion (version, latestVersion) {
  const exactVersion = semver.clean(version)

  // If exact version is too high, cap it
  if (semver.gt(exactVersion, latestVersion)) {
    return latestVersion
  }

  // Otherwise keep exact version with cap
  return `${exactVersion} <=${latestVersion}`
}

// Handle general semver ranges
function handleValidRange (range, latestVersion) {
  // Only apply cap if necessary
  if (semver.subset(`<=${latestVersion}`, range)) {
    return range
  }

  // Extract lower bound from the range if possible
  const lowerBound = extractLowerBound(range)

  if (lowerBound) {
    return `>=${lowerBound.version} <=${latestVersion}`
  } else {
    return `<=${latestVersion}`
  }
}

// Extract the lower bound from a semver range
function extractLowerBound (range) {
  const parsedRange = new semver.Range(range)
  let lowerBound = null

  if (parsedRange.set && parsedRange.set.length > 0) {
    for (const comparators of parsedRange.set) {
      for (const comparator of comparators) {
        if (comparator.operator === '>=' || comparator.operator === '>') {
          if (!lowerBound || semver.gt(comparator.semver, lowerBound)) {
            lowerBound = comparator.semver
          }
        }
      }
    }
  }

  return lowerBound
}

async function assertPackage (name, version, dependencyVersionRange, external) {
  // Apply version cap from latests.json if available
  let cappedVersionRange = dependencyVersionRange

  if (latests.latests[name]) {
    const latestVersion = latests.latests[name]

    // Only process string version ranges
    if (dependencyVersionRange && typeof dependencyVersionRange === 'string') {
      cappedVersionRange = applyCap(dependencyVersionRange, latestVersion)
    }
  }
  const dependencies = { [name]: cappedVersionRange }
  if (deps[name]) {
    await addDependencies(dependencies, name, cappedVersionRange)
  }
  const pkg = {
    name: [name, sha1(name).substr(0, 8), sha1(version)].filter(val => val).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies
  }

  if (!external) {
    if (name === 'aerospike') {
      pkg.installConfig = {
        hoistingLimits: 'workspaces'
      }
    } else {
      pkg.workspaces = {
        nohoist: ['**/**']
      }
    }
  }
  fs.writeFileSync(filename(name, version, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

async function addDependencies (dependencies, name, versionRange) {
  const versionList = await getVersionList(name)
  const version = semver.maxSatisfying(versionList, versionRange)
  const pkgJson = await npmView(`${name}@${version}`)
  for (const dep of deps[name]) {
    for (const section of ['devDependencies', 'peerDependencies']) {
      if (pkgJson[section] && dep in pkgJson[section]) {
        if (pkgJson[section][dep].includes('||')) {
          // Use the first version in the list (as npm does by default)
          dependencies[dep] = pkgJson[section][dep].split('||')[0].trim()
        } else {
          // Only one version available so use that.
          dependencies[dep] = pkgJson[section][dep]
        }
        break
      }
    }
  }
}

async function getVersionList (name) {
  if (versionLists[name]) {
    return versionLists[name]
  }
  const list = await npmView(`${name} versions`)
  versionLists[name] = list
  return list
}

function npmView (input, retry = true) {
  return new Promise((resolve, reject) => {
    childProcess.exec(`npm view ${input} --json`, (err, stdout) => {
      if (err) {
        return retry ? npmView(input, false).then(resolve, reject) : reject(err)
      }
      resolve(JSON.parse(stdout.toString('utf8')))
    })
  })
}

function assertIndex (name, version) {
  const index = `'use strict'

const requirePackageJson = require('${requirePackageJsonPath}')

module.exports = {
  get (id) { return require(id || '${name}') },
  getPath (id) { return require.resolve(id || '${name}' ) },
  version () { return requirePackageJson('${name}', module).version }
}
`
  fs.writeFileSync(filename(name, version, 'index.js'), index)
}

function assertWorkspace () {
  fs.writeFileSync(filename(null, null, 'package.json'), JSON.stringify({
    name: 'versions',
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    workspaces: {
      packages: Array.from(workspaces)
    }
  }, null, 2) + '\n')
}

function install () {
  try {
    exec('yarn --ignore-engines', { cwd: folder() })
  } catch (e) { // retry in case of server error from registry
    exec('yarn --ignore-engines', { cwd: folder() })
  }
}

function addFolder (name, version) {
  const basename = [name, version].filter(val => val).join('@')
  if (!excludeList.includes(name)) workspaces.add(basename)
}

function folder (name, version) {
  const basename = [name, version].filter(val => val).join('@')
  return path.join(__dirname, '..', 'versions', basename)
}

function filename (name, version, file) {
  return path.join(folder(name, version), file)
}

function sha1 (str) {
  if (!str) return

  const shasum = crypto.createHash('sha1')
  shasum.update(str)
  return shasum.digest('hex')
}
