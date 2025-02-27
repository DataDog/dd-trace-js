'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const semver = require('semver')
const exec = require('./helpers/exec')
const externals = require('../packages/dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const {
  getVersionList,
  npmView
} = require('./helpers/versioning')
const latests = require('../packages/datadog-instrumentations/src/helpers/latests.json')

const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase <= 3.2.0
const excludeList = os.arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
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
  const name = instrumentation.name
  const versions = process.env.PACKAGE_VERSION_RANGE && !external
    ? [process.env.PACKAGE_VERSION_RANGE]
    : [].concat(instrumentation.versions || [])

  for (const versionRange of versions) {
    if (!versionRange || versionRange === '*') continue

    // For exact versions, just use them
    if (semver.valid(versionRange)) {
      await assertModules(name, versionRange, external)
      continue
    }
    // For version ranges
    if (semver.validRange(versionRange)) {
      const latestVersion = latests.latests[name]

      // Always install the latest version from latests.json if it satisfies the range
      if (latestVersion && semver.satisfies(latestVersion, versionRange)) {
        await assertModules(name, latestVersion, external)
      }

      // For ranges with a minimum version (like >=2.0.0), also install the minimum version
      if (versionRange.startsWith('>=')) {
        // Extract the exact version after >=
        const minVersion = versionRange.substring(2).trim()

        // If it's not a valid semver (like just "2"), coerce it to a proper version (2.0.0)
        const parsedMinVersion = semver.valid(minVersion) ? minVersion : semver.coerce(minVersion).version

        if (parsedMinVersion && parsedMinVersion !== latestVersion) {
          await assertModules(name, parsedMinVersion, external)
        }
      }

      // For broader ranges, get the lower bound
      if (!versionRange.startsWith('>=')) {
        let lowerBound
        try {
          // Try to extract the lower bound from the range
          lowerBound = semver.coerce(versionRange).version
        } catch (e) {
          // FIX ME: log?
        }

        if (lowerBound && lowerBound !== latestVersion) {
          await assertModules(name, lowerBound, external)
        }
      }
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

async function assertPackage (name, version, dependencyVersionRange, external) {
  const dependencies = { [name]: dependencyVersionRange }
  if (deps[name]) {
    await addDependencies(dependencies, name, dependencyVersionRange)
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
  let versionList = await getVersionList(name)
  if (!latests.pinned.includes(name)) {
    const maxVersion = latests.latests[name]
    versionList = versionList.map(version => {
      if (version.startsWith('>=') && !version.includes('<')) {
        return version + ' <=' + maxVersion
      } else {
        return version
      }
    })
  }
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
  // Skip if either name or version is undefined
  // was seeing many of these in the logs when debugging
  // e.g. mysql@undefined
  if (!name || !version) {
    return
  }

  const basename = `${name}@${version}`

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
