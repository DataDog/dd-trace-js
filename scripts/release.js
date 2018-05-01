'use strict'

const exec = require('child_process').execSync
const pkg = require('../package.json')

const version = pkg.version

exec('npm whoami')
exec('git checkout master')
exec('git pull')
exec(`git tag v${version}`)
exec(`git push origin v${version}`)
exec('npm publish')
