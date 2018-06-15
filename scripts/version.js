'use strict'

const path = require('path')
const fs = require('fs')
const semver = require('semver')
const exec = require('./helpers/exec')
const title = require('./helpers/title')

title('Pulling latest changes from master')

exec(`git checkout master`)
exec(`git pull`)

const pkg = require('../package.json')
const increment = getIncrement()
const version = semver.inc(pkg.version, increment)

title(`Bumping version to v${version} in a new branch`)

pkg.version = version

exec(`git checkout -b v${version}`)
write('package.json', JSON.stringify(pkg, null, 2) + '\n')
write('lib/version.js', `module.exports = '${version}'\n`)
add('package.json')
add('lib/version.js')
exec(`git commit -m "v${version}"`)
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
