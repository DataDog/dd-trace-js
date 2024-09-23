const {
  getInternals,
  npmView
} = require('./helpers/versioning')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const yaml = require('js-yaml')

const latestsPath = path.join(
  __dirname,
  '..',
  'packages',
  'datadog-instrumentations',
  'src',
  'helpers',
  'latests.json'
)

const matricesPath = path.join(
  __dirname,
  '..',
  'packages',
  'datadog-instrumentations',
  'src',
  'helpers',
  'matrices.json'
)

const latestsJson = require(latestsPath)
const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
  .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))

const matricesJson = require(matricesPath)
const pluginsNames = Object.getOwnPropertyNames(yaml.load(fs.readFileSync(matricesPath, 'utf-8')).matrices)

// TODO A lot of this can be optimized by using `npm outdated`.

function makeAPR (branchName) {
  const title = 'Fix: Update Outdated Versions'
  const body = 'Checking for and updating outdated integration versions'
  execSync(`gh pr create --title ${title} --body ${body} --base master --head ${branchName} `)
}

function maxVersion (range) {
  if (typeof range === 'string') {
    return range
  }
  return range.pop()
}

function minVersion (range) {
  if (typeof range === 'string') {
    return range
  }
  return range.shift()
}

function splitting (element) {
  return +element.split('.')[0]
}

async function ranges (name, minimum) {
  const distTags = await npmView(`${name} dist-tags`)
  const latestVersion = splitting(distTags?.latest)

  const splitMin = splitting(minimum)

  const ranges = []
  let versionRange
  let maxRange
  let minRange

  for (let major = splitMin; major <= latestVersion; major++) {
    try {
      versionRange = await npmView(`${name}@${major} version`)
      maxRange = maxVersion(versionRange)
      minRange = minVersion(versionRange)

      if (major === splitMin) {
        ranges.push(`${minimum} - ${maxRange}`)
      } else if (versionRange !== undefined) {
        ranges.push(`${minRange} - ${maxRange}`)
      }
    } catch (e) {
      console.log(`No version range found for "${name}" at version ${major}`)
    }
  }
  return ranges
}

async function fix () {
  let latests

  for (const name of pluginsNames) {
    latests = matricesJson.matrices[name]
    const minVersion = latests['min-version']
    const versions = await ranges(name, minVersion)

    latests.range = versions
  }
  fs.writeFileSync(matricesPath, JSON.stringify(matricesJson, null, 2))

  const result = execSync('git status').toString()

  if (result.includes(matricesPath)) {
    const branchName = 'update_outdated_integrations'
    try {
      execSync(`git checkout -b ${branchName}`)
      execSync(`git add ${matricesPath}`)
      execSync('git commit -m "fix: update integr latests.json"')
      execSync(`git push origin ${branchName}`)

      makeAPR(branchName)
    } catch (e) {
      console.log('ERROR', e)
      process.exitCode = 1
    }
  }
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
