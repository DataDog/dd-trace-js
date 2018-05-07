'use strict'

const exec = require('child_process').execSync

exec('npm whoami')
exec('git checkout master')
exec('git pull')

const pkg = require('../package.json')

exec(`git tag v${pkg.version}`)
exec(`git push origin refs/tags/v${pkg.version}`)
exec('npm publish')
