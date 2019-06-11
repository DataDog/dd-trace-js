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
    .filter(key => key !== 'index')

  if (process.env.hasOwnProperty('PLUGINS')) {
    filter = process.env.PLUGINS.split('|')
    names = names.filter(name => ~filter.indexOf(name))
  }

  const internals = names
    .map(key => plugins[key])
    .reduce((prev, next) => prev.concat(next), [])

  internals.forEach(assertInstrumentation)

  Object.keys(externals)
    .filter(name => ~names.indexOf(name))
    .forEach(name => {
      [].concat(externals[name]).forEach(assertInstrumentation)
    })
}

function assertInstrumentation (instrumentation) {
  [].concat(instrumentation.versions).forEach(version => {
    if (version) {
      assertModules(instrumentation.name, semver.coerce(version).version)
      assertModules(instrumentation.name, version)
    }
  })
}

function assertModules (name, version) {
  addFolder(name)
  addFolder(name, version)
  assertFolder(name)
  assertFolder(name, version)
  assertPackage(name, null, version)
  assertPackage(name, version, version)
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

function assertPackage (name, version, dependency) {
  fs.writeFileSync(filename(name, version, 'package.json'), JSON.stringify({
    name: [name, sha1(name).substr(0, 8), sha1(version)].filter(val => val).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    optionalDependencies: {
      [name]: dependency
    }
  }, null, 2) + '\n')
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
    workspaces: Array.from(workspaces)
  }, null, 2) + '\n')
}

function install () {
  exec('yarn', { cwd: folder() })
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
