const {
  getInternals,
  npmView
} = require('./helpers/versioning')
const path = require('path')
const fs = require('fs')

const latestsPath = path.join(
  __dirname,
  '..',
  'packages',
  'datadog-instrumentations',
  'src',
  'helpers',
  'latests.json'
)
const latestsJson = require(latestsPath)
const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
  .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))

// TODO A lot of this can be optimized by using `npm outdated`.

async function fix () {
  const latests = {}
  for (const name of internalsNames) {
    const distTags = await npmView(name + ' dist-tags')
    const latest = distTags.latest
    latests[name] = latest
  }
  latestsJson.latests = latests
  fs.writeFileSync(latestsPath, JSON.stringify(latestsJson, null, 2))
}

async function check () {
  for (const name of internalsNames) {
    const latest = latestsJson.latests[name]
    if (!latest) {
      console.log(`No latest version found for "${name}"`)
      process.exitCode = 1
    }
    const distTags = await npmView(name + ' dist-tags')
    const npmLatest = distTags.latest
    if (npmLatest !== latest) {
      console.log(`"latests.json: is not up to date for "${name}": expected "${npmLatest}", got "${latest}"`)
      process.exitCode = 1
    }
  }
}

if (process.argv.includes('fix')) fix()
else check()
