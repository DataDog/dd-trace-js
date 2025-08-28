'use strict'

/* eslint-disable no-console */
/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=22.0.0' }] */

const fs = require('fs')
const path = require('path')
// const util = require('util')
const yaml = require('yaml')
// const semver = require('semver')
const { execSync } = require('child_process')
const Module = require('module')
const { getAllInstrumentations } = require('../packages/dd-trace/test/setup/helpers/load-inst')

function errorMsg (title, ...message) {
  console.log('===========================================')
  console.log(title)
  console.log('-------------------------------------------')
  console.log(...message)
  console.log('\n')
  process.exitCode = 1
}

/// /
/// / Verifying that plugins are consistently tested in at least one GH workflow
/// /

if (!Module.isBuiltin) {
  Module.isBuiltin = mod => Module.builtinModules.includes(mod)
}

// const nodeMajor = Number(process.versions.node.split('.')[0])

const instrumentations = getAllInstrumentations()

// const versions = {}

const allTestedPlugins = new Set()
const appsecTestedPlugins = new Set()

function getStrayPluginFiles (folder) {
  const pluginFiles = execSync(`find ${folder} -type f -name "*.plugin.spec.js"`)
    .toString()
    .split('\n')
    .slice(0, -1)
    .map(filepath => {
      const split = path.basename(filepath).split('.')
      return split[split.length - 4]
    })

  return new Set(pluginFiles)
}

function checkPlugins (yamlPath) {
  const yamlContent = yaml.parse(fs.readFileSync(yamlPath, 'utf8'))

  const rangesPerPluginFromYaml = {}
  const rangesPerPluginFromInst = {}
  for (const jobName in yamlContent.jobs) {
    const job = yamlContent.jobs[jobName]
    if (!job.env || !job.env.PLUGINS) continue

    const pluginName = job.env.PLUGINS
    if (yamlPath.includes('appsec')) {
      pluginName.split('|').forEach(plugin => appsecTestedPlugins.add(plugin))
    } else {
      pluginName.split('|').forEach(plugin => allTestedPlugins.add(plugin))
    }

    if (Module.isBuiltin(pluginName)) continue
    const rangesFromYaml = getRangesFromYaml(job)
    if (rangesFromYaml) {
      if (!rangesPerPluginFromYaml[pluginName]) {
        rangesPerPluginFromYaml[pluginName] = new Set()
      }
      rangesFromYaml.forEach(range => rangesPerPluginFromYaml[pluginName].add(range))
      const plugin = instrumentations[pluginName]
      const allRangesForPlugin = new Set(plugin.map(x => x.versions).flat())
      rangesPerPluginFromInst[pluginName] = allRangesForPlugin
    }
  }

  // DISABLED FOR NOW BECAUSE NPM SHOW GETS RATE LIMITED
  //   for (const pluginName in rangesPerPluginFromYaml) {
  //     const yamlRanges = Array.from(rangesPerPluginFromYaml[pluginName])
  //     const instRanges = Array.from(rangesPerPluginFromInst[pluginName])
  //     const yamlVersions = getMatchingVersions(pluginName, yamlRanges)
  //     const instVersions = getMatchingVersions(pluginName, instRanges)
  //     if (pluginName !== 'next' && !util.isDeepStrictEqual(yamlVersions, instVersions)) {
  //       const opts = { colors: true }
  //       const colors = x => util.inspect(x, opts)
  //       pluginErrorMsg(pluginName, 'Mismatch', `
  // Valid version ranges from YAML: ${colors(yamlRanges)}
  // Valid version ranges from INST: ${colors(instRanges)}
  // ${mismatching(yamlVersions, instVersions)}
  // Note that versions may be dependent on Node.js version. This is Node.js v${colors(nodeMajor)}
  // > These don't match the same sets of versions in npm.
  // >
  // > Please check ${yamlPath} and the instrumentations
  // > for ${pluginName} to see that the version ranges match.`.trim())
  //     }
  //   }
}

function getRangesFromYaml (job) {
  // eslint-disable-next-line no-template-curly-in-string
  if (job.env && job.env.PACKAGE_VERSION_RANGE && job.env.PACKAGE_VERSION_RANGE !== '${{ matrix.range }}') {
    pluginErrorMsg(job.env.PLUGINS, 'ERROR in YAML', 'You must use matrix.range instead of env.PACKAGE_VERSION_RANGE')
    process.exitCode = 1
  }
  if (job.strategy && job.strategy.matrix && job.strategy.matrix.range) {
    const possibilities = [job.strategy.matrix]
    if (job.strategy.matrix.include) {
      possibilities.push(...job.strategy.matrix.include)
    }
    return possibilities.flatMap(possibility => {
      return [possibility.range]?.flat()
    })
  }

  return null
}

// function getMatchingVersions (name, ranges) {
//   if (!versions[name]) {
//     versions[name] = JSON.parse(execSync('npm show ' + name + ' versions --json').toString())
//   }
//   return versions[name].filter(version => ranges.some(range => semver.satisfies(version, range)))
// }

// function mismatching (yamlVersions, instVersions) {
//   const yamlSet = new Set(yamlVersions)
//   const instSet = new Set(instVersions)

//   const onlyInYaml = yamlVersions.filter(v => !instSet.has(v))
//   const onlyInInst = instVersions.filter(v => !yamlSet.has(v))

//   const opts = { colors: true }
//   return [
//     `Versions only in YAML: ${util.inspect(onlyInYaml, opts)}`,
//     `Versions only in INST: ${util.inspect(onlyInInst, opts)}`
//   ].join('\n')
// }

function pluginErrorMsg (pluginName, title, message) {
  errorMsg(title + ' for ' + pluginName, message)
}

// TODO: Check all YAML files instead of having to list them here.
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'apm-integrations.yml'))
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'appsec.yml'))
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'llmobs.yml'))
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'platform.yml'))
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'test-optimization.yml'))
checkPlugins(path.join(__dirname, '..', '.github', 'workflows', 'serverless.yml'))
{
  const testDir = path.join(__dirname, '..', 'packages', 'datadog-instrumentations', 'test')
  const testedInstrumentations = fs.readdirSync(testDir)
    .filter(file => file.endsWith('.spec.js'))
    .map(file => file.replace('.spec.js', ''))
  for (const instrumentation of testedInstrumentations) {
    if (!allTestedPlugins.has(instrumentation)) {
      pluginErrorMsg(instrumentation, 'ERROR', 'Instrumentation is tested but not in at least one GitHub workflow')
    }
  }
  const allPlugins = fs.readdirSync(path.join(__dirname, '..', 'packages'))
    .filter(file => file.startsWith('datadog-plugin-'))
    .filter(file => fs.existsSync(path.join(__dirname, '..', 'packages', file, 'test')))
    .map(file => file.replace('datadog-plugin-', ''))
  for (const plugin of allPlugins) {
    if (!allTestedPlugins.has(plugin)) {
      pluginErrorMsg(plugin, 'ERROR', 'Plugin is tested but not in at least one GitHub workflow')
    }
  }

  for (const plugin of getStrayPluginFiles(path.join(__dirname, '..', 'packages', 'dd-trace', 'test', 'appsec'))) {
    if (!appsecTestedPlugins.has(plugin)) {
      pluginErrorMsg(plugin, 'ERROR', 'Appsec plugin is tested but not in at least one GitHub workflow')
    }
  }
  // TODO: do this with all jobs that have excludes in package.json

}

/// /
/// / Verifying that tests run on correct triggers
/// /

const IGNORED_WORKFLOWS = {
  all: [
    'audit.yml',
    'codeql-analysis.yml',
    'dependabot-automation.yml',
    'flakiness.yml',
    'pr-labels.yml',
    'release-3.yml',
    'release-4.yml',
    'release-dev.yml',
    'release-latest.yml',
    'release-proposal.yml',
    'release-validate.yml',
    'retry.yml'
  ],
  trigger_pull_request: [
    'eslint-rules.yml',
    'stale.yml'
  ],
  trigger_push: [
    'stale.yml'
  ],
  trigger_schedule: [
    'eslint-rules.yml',
    'project.yml'
  ]
}

const workflows = fs.readdirSync(path.join(__dirname, '..', '.github', 'workflows'))
  .filter(file =>
    !IGNORED_WORKFLOWS.all
      .reduce((contained, name) => contained || file.includes(name), false)
  )

function triggersError (workflow, ...text) {
  errorMsg('ERROR in ' + workflow, ...text)
}

for (const workflow of workflows) {
  const yamlPath = path.join(__dirname, '..', '.github', 'workflows', workflow)
  const yamlContent = yaml.parse(fs.readFileSync(yamlPath, 'utf8'))
  const triggers = yamlContent.on
  if (!IGNORED_WORKFLOWS.trigger_pull_request.includes(workflow) &&
      triggers?.pull_request !== null) {
    triggersError(workflow, 'The `pull_request` trigger should be blank')
  }
  if (!IGNORED_WORKFLOWS.trigger_push.includes(workflow) &&
      triggers?.push?.branches?.[0] !== 'master') {
    triggersError(workflow, 'The `push` trigger should run on master')
  }
  if (!IGNORED_WORKFLOWS.trigger_schedule.includes(workflow) &&
      triggers?.schedule?.[0]?.cron !== '0 4 * * *') {
    triggersError(workflow, 'The `cron` trigger should be \'0 4 * * *\'')
  }
}
