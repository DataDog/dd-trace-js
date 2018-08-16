'use strict'

const exec = require('./helpers/exec')
const title = require('./helpers/title')

title(`Publishing API documentation to GitHub Pages`)

const msg = process.argv[2]

if (!msg) {
  throw new Error('Please provide a reason for the change. Example: node scripts/publish_docs.js "fix typo"')
}

exec('yarn install')
exec('rm -rf ./out')
exec('git clone -b gh-pages --single-branch git@github.com:DataDog/dd-trace-js.git out')
exec('yarn jsdoc')
exec('git add -A', { cwd: './out' })
exec(`git commit -m "${msg}"`, { cwd: './out' })
exec('git push', { cwd: './out' })
