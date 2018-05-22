'use strict'

const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Publishing package to the npm registry`)

const pkg = require('../package.json')

exec('npm whoami')
exec('git checkout master')
exec('git pull')
exec('npm publish')
exec(`node scripts/publish_docs.js "v${pkg.version}"`)
