'use strict'

const path = require('path')
const fs = require('fs')
const semver = require('semver')
const exec = require('./helpers/exec')
const title = require('./helpers/title')

const pkg = require('../package.json')
const increment = getIncrement()
const version = semver.inc(pkg.version, increment)
const branch = `v${semver.major(version)}.${semver.minor(version)}`
const tag = `v${version}`
const isNewBranch = semver.major(pkg.version) !== semver.major(version) ||
  semver.minor(pkg.version) !== semver.minor(version)

title(`Bumping version to v${version} in a new branch`)

pkg.version = version

if (isNewBranch) {
  exec(`git checkout master`)
  exec(`git pull`)
  exec(`git checkout -b ${branch}`)
} else {
  exec(`git checkout ${branch}`)
  exec('git pull')
}

write('package.json', JSON.stringify(pkg, null, 2) + '\n')
write('packages/dd-trace/lib/version.js', `module.exports = '${version}'\n`)
add('package.json')
add('packages/dd-trace/lib/version.js')
exec(`git commit -m "${tag}"`)
exec(`git push -u origin HEAD`)

function getIncrement () {
  const increments = ['major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease']
  const index = increments.indexOf(process.argv[2])

  if (index === -1) {
    throw new Error(`increment must be one of ${increments.join(', ')}`)
  }

  return increments[index]
}

function filename (relativePath) {
  return path.normalize(path.join(__dirname, '..', relativePath))
}

function write (file, data) {
  fs.writeFileSync(filename(file), data)
}

function add (file) {
  exec(`git add ${filename(file)}`)
}
