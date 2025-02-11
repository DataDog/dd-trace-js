'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { capture, run } = require('./helpers/terminal')
const pkg = require('../../package.json')

const version = pkg.version
const tag = `v${version}`
const major = version.split('.')[0]
const body = capture(`gh pr view ${tag}-proposal --json body --jq '.body'`)
const args = process.argv.slice(2)
const flags = []
const folder = path.join(os.tmpdir(), 'release_notes')
const file = path.join(folder, `${tag}.md`)

// Default is to determine this automatically, so set it explicitly instead.
flags.push(args.includes('--latest') ? '--latest' : '--latest=false')

if (version.includes('-')) {
  flags.push('--prerelease')
}

fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(file, body)

run(`gh release create ${tag} --target v${major}.x --title ${version} -F ${file} ${flags.join(' ')}`)
