'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const semver = require('semver')
const exec = require('./helpers/exec')
const plugins = require('../packages/dd-trace/src/plugins')
const externals = require('../packages/dd-trace/test/plugins/externals')

const workspaces = new Set()

run()

function run () {
  assertFolder()
  assertVersions()
  assertWorkspace()
  install()
}

function assertVersions () {
  let filter = []
  let names = Object.keys(plugins)

  if (process.env.hasOwnProperty('PLUGINS')) {
    filter = process.env.PLUGINS.split('|')
    names = names.filter(name => ~filter.indexOf(name))
  }

  const internals = names
    .map(key => plugins[key])
    .reduce((prev, next) => prev.concat(next), [])

  internals.forEach((inst) => {
    assertInstrumentation(inst, false)
  })

  Object.keys(externals)
    .filter(name => ~names.indexOf(name))
    .forEach(name => {
      [].concat(externals[name]).forEach(inst => assertInstrumentation(inst, true))
    })
}

function assertInstrumentation (instrumentation, external) {
  [].concat(instrumentation.versions).forEach(version => {
    if (version) {
      assertModules(instrumentation.name, semver.coerce(version).version, external)
      assertModules(instrumentation.name, version, external)
    }
  })
}

function assertModules (name, version, external) {
  addFolder(name)
  addFolder(name, version)
  assertFolder(name)
  assertFolder(name, version)
  assertPackage(name, null, version, external)
  assertPackage(name, version, version, external)
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

function assertPackage (name, version, dependency, external) {
  const pkg = {
    name: [name, sha1(name).substr(0, 8), sha1(version)].filter(val => val).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies: {
      [name]: dependency
    }
  }

  if (!external) {
    pkg.workspaces = {
      nohoist: ['**/**']
    }
  }
  fs.writeFileSync(filename(name, version, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

function assertIndex (name, version) {
  const index = `'use strict'

module.exports = {
  get (id) { return require(id || '${name}') },
  version () { return require('${name}/package.json').version }
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
