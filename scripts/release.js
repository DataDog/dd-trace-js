'use strict'

const fs = require('fs')
const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Publishing package to the npm registry`)

exec('npm whoami')
exec('git checkout master')
exec('git pull')
exec('npm publish')

title(`Publishing API documentation to GitHub Pages`)

const pkg = require('../package.json')

if (fs.existsSync('yarn.lock')) {
  exec('yarn')
} else {
  exec('npm install')
}

exec('rm -rf ./out')
exec('git clone -b gh-pages --single-branch git@github.com:DataDog/dd-trace-js.git out')
exec('npm run jsdoc')
exec('git add -A', { cwd: './out' })
exec(`git commit -m "v${pkg.version}"`, { cwd: './out' })
exec('git push', { cwd: './out' })
