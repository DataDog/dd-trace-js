'use strict'

const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Publishing package to the npm registry`)

exec('git checkout master')
exec('git pull')

const pkg = require('../package.json')

exec(`git tag v${pkg.version}`)
exec(`git push origin refs/tags/v${pkg.version}`)
exec('yarn publish')
exec(`node scripts/publish_docs.js "v${pkg.version}"`)
