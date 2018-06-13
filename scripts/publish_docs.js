'use strict'

const fs = require('fs')
const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Publishing API documentation to GitHub Pages`)

const msg = process.argv[2]

if (!msg) {
  throw new Error('Please provide a reason for the change. Example: node scripts/publish_docs.js "fix typo"')
}

if (fs.existsSync('yarn.lock')) {
  exec('yarn')
} else {
  exec('npm install')
}

exec('rm -rf ./out')
exec('git clone -b gh-pages --single-branch git@github.com:DataDog/dd-trace-js.git out')
exec('npm run jsdoc')
exec('git add -A', { cwd: './out' })
exec(`git commit -m "${msg}"`, { cwd: './out' })
exec('git push', { cwd: './out' })
