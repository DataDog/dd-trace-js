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

const yamlPath = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'plugins.yml'
)
const latestsJson = require(latestsPath)
const internalsNames = Array.from(new Set(getInternals().map(n => n.name)))
  .filter(x => typeof x === 'string' && x !== 'child_process' && !x.startsWith('node:'))

// TODO A lot of this can be optimized by using `npm outdated`.

function makeAPR (branchName) {
  const title = 'Fix: Update Outdated Versions'
  const body = 'Checking for and updating outdated integration versions'
  execSync(`gh pr create --title ${title} --body ${body} --base master --head ${branchName} `)
}

function updatePluginsYaml () {
  const plugins = yaml.load(fs.readFileSync(yamlPath, 'utf-8'))
  const jobs = plugins.jobs

  for (const job in jobs) {
    if (jobs[job]?.strategy?.matrix?.range) { console.log('found range', job, jobs[job]?.strategy?.matrix?.range) }
  }
}

async function fix () {
  updatePluginsYaml()
  const latests = {}
  for (const name of internalsNames) {
    const distTags = await npmView(name + ' dist-tags')
    const latest = distTags.latest
    latests[name] = latest
  }
  latestsJson.latests = latests
  fs.writeFileSync(latestsPath, JSON.stringify(latestsJson, null, 2))

  const result = execSync('git status').toString()

  if (result.includes(latestsPath)) {
    const branchName = 'fix_outdated_integrations'
    try {
      execSync(`git checkout -b ${branchName}`)
      execSync(`git add ${latestsPath}`)
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
