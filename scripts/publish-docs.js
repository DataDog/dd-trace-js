'use strict'

const exec = require('./helpers/exec')
const title = require('./helpers/title')

title('Publishing API documentation to GitHub Pages')

const msg = process.argv[2]

if (!msg) {
  throw new Error('Please provide a reason for the change. Example: node scripts/publish-docs.js "fix typo"')
}

try {
  exec('yarn install', { cwd: './docs' })
} catch (e) { // retry in case of error from registry
  exec('yarn install', { cwd: './docs' })
}

exec('rm -rf ./out', { cwd: './docs' })
exec('yarn type:doc') // run first because typedoc requires an empty directory
exec('git init', { cwd: './docs/out' }) // cloning would overwrite generated docs
exec('git remote add origin git@github.com:DataDog/dd-trace-js.git', { cwd: './docs/out' })
exec('git add -A', { cwd: './docs/out' })
exec(`git commit -m "${msg}"`, { cwd: './docs/out' })
exec('git push -f origin main:gh-pages', { cwd: './docs/out' })
