'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const semver = require('semver')
const proxyquire = require('proxyquire')
const exec = require('./helpers/exec')
const childProcess = require('child_process')
const plugins = require('../packages/dd-trace/src/plugins')
const Plugin = require('../packages/dd-trace/src/plugins/plugin')
const externals = require('../packages/dd-trace/test/plugins/externals')

const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

const workspaces = new Set()
const versionLists = {}
const deps = {}
Object.keys(externals).forEach(external => externals[external].forEach(thing => {
  if (thing.dep) {
    if (!deps[external]) {
      deps[external] = []
    }
    deps[external].push(thing.name)
  }
}))

fs.readdirSync(path.join(__dirname, '../packages/datadog-instrumentations/src'))
  .filter(file => file.endsWith('js'))
  .forEach(file => {
    file = file.replace('.js', '')
    plugins[file] = { name: file, prototype: Object.create(Plugin.prototype) }
  })

run()

async function run () {
  assertFolder()
  await assertVersions()
  assertWorkspace()
  install()
}

async function assertVersions () {
  let filter = []
  let names = Object.keys(plugins)

  if (process.env.hasOwnProperty('PLUGINS')) {
    filter = process.env.PLUGINS.split('|')
    names = names.filter(name => ~filter.indexOf(name))
  }

  const internals = names
    .map(key => {
      const plugin = plugins[key]
      console.log(plugin)
      if (plugin.prototype instanceof Plugin) {
        console.log(key)
        const instrumentations = []
        const instrument = {
          addHook (instrumentation) {
            instrumentations.push(instrumentation)
          }
        }
        const instPath = path.join(
          __dirname,
          `../packages/datadog-instrumentations/src/${plugin.name}.js`
        )
        proxyquire.noPreserveCache()(instPath, {
          './helpers/instrument': instrument
        })
        console.log(instrumentations)
        return instrumentations
      } else {
        return plugin
      }
    })
    .reduce((prev, next) => prev.concat(next), [])

  for (const inst of internals) {
    await assertInstrumentation(inst, false)
  }

  const externalNames = Object.keys(externals).filter(name => ~names.indexOf(name))
  for (const name of externalNames) {
    for (const inst of [].concat(externals[name])) {
      if (!inst.dep) {
        await assertInstrumentation(inst, true)
      }
    }
  }
}

async function assertInstrumentation (instrumentation, external) {
  const versions = [].concat(instrumentation.versions)
  for (const version of versions) {
    if (version) {
      await assertModules(instrumentation.name, semver.coerce(version).version, external)
      await assertModules(instrumentation.name, version, external)
    }
  }
}

async function assertModules (name, version, external) {
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

async function assertPackage (name, version, dependency, external) {
  const dependencies = { [name]: dependency }
  if (deps[name]) {
    await addDependencies(dependencies, name, dependency)
  }
  const pkg = {
    name: [name, sha1(name).substr(0, 8), sha1(version)].filter(val => val).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies
  }

  if (!external) {
    pkg.workspaces = {
      nohoist: ['**/**']
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
        dependencies[dep] = pkgJson[section][dep]
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

function npmView (input) {
  return new Promise((resolve, reject) => {
    childProcess.exec(`npm view ${input} --json`, (err, stdout) => {
      if (err) {
        reject(err)
        return
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
  exec('yarn --ignore-engines', { cwd: folder() })
}

function addFolder (name, version) {
  const basename = [name, version].filter(val => val).join('@')
  workspaces.add(basename)
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
