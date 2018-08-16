'use strict'

const fs = require('fs')
const path = require('path')
const requireDir = require('require-dir')
const crypto = require('crypto')
const semver = require('semver')
const exec = require('./helpers/exec')
const plugins = requireDir('../src/plugins')

const workspaces = new Set()

run()

function run () {
  assertVersions()
  assertWorkspace()
  install()
}

function assertVersions () {
  Object.keys(plugins).filter(key => key !== 'index').forEach(key => {
    [].concat(plugins[key]).forEach(instrumentation => {
      [].concat(instrumentation.versions).forEach(version => {
        if (version) {
          assertModules(instrumentation.name, version)
          assertModules(instrumentation.name, semver.coerce(version).version)
        }
      })
    })
  })
}

function assertModules (name, version) {
  addFolder(name, version)
  assertFolder(name, version)
  assertPackage(name, version)
  assertIndex(name, version)
}

function assertFolder (name, version) {
  if (!fs.existsSync(folder())) {
    fs.mkdirSync(folder())
  }

  if (!fs.existsSync(folder(name, version))) {
    fs.mkdirSync(folder(name, version))
  }
}

function assertPackage (name, version) {
  fs.writeFileSync(filename(name, version, 'package.json'), JSON.stringify({
    name: [name, sha1(version)].filter(val => val).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies: {
      [name]: version
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
  return path.join(__dirname, '..', 'test', 'plugins', 'versions', basename)
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
