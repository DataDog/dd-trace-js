'use strict'

const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Creating a GitHub release`)

exec('git pull')

const pkg = require('../package.json')

exec(`git tag v${pkg.version}`)
exec(`git push origin refs/tags/v${pkg.version}`)
