const {
  getInternals,
  npmView
} = require('./helpers/versioning')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const yaml = require('js-yaml')

// const { generateMatrix } = require('./create_matrix')

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

const versionsPath = path.join(
  __dirname,
  '..',
  'packages',
  'datadog-instrumentations',
  'src',
  'helpers',
  'versions.json'
)

const latestsJson = require(latestsPath)
const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
  .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))

const matricesJson = require(matricesPath)
const versionsJson = require(versionsPath)
const pluginNames = Object.getOwnPropertyNames(yaml.load(fs.readFileSync(matricesPath, 'utf-8')).matrices)

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

async function updateRange (name, major) {
  const versionRange = await npmView(`${name}@${major} version`)

  const maxRange = maxVersion(versionRange)

  return maxRange
}

async function loopRange (name, range) {
  for (let ele = 0; ele < range.length; ele++) {
    const latest = range[ele].split(' - ')
    const major = +latest[0].split('.')[0]

    latest[1] = await updateRange(name, major)
    range[ele] = `${latest[0]} - ${latest[1]}`
  }
  fs.writeFileSync(versionsPath, JSON.stringify(versionsJson, null, 2))
}

async function updatePlugin (name) {
  const plugin = versionsJson.matrices[name]

  if (plugin['by-node-version'] === true) {
    for (const versions in plugin['node-versions']) {
      const pluginRange = plugin['node-versions']
      loopRange(name, pluginRange[versions])
    }
  } else {
    loopRange(name, plugin.range)
  }
}

async function fix () {
  for (const name of pluginNames) {
    await updatePlugin(name)
    // generateMatrix(name)
  }

  const result = execSync('git status').toString()

  if (result.includes(versionsPath)) {
    const branchName = 'update_outdated_integrations'
    try {
      execSync(`git checkout -b ${branchName}`)
      execSync(`git add ${versionsPath}`)
      execSync('git commit -m "fix: update integr versions.json"')
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

function minVersion (range) {
  if (typeof range === 'string') {
    return range
  }
  return range.shift()
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

function splitting (element) {
  return +element.split('.')[0]
}

if (process.argv.includes('fix')) fix()
else check()
