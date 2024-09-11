'use strict'
/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const util = require('util')
const proxyquire = require('proxyquire')
const yaml = require('yaml')
const semver = require('semver')
const { execSync } = require('child_process')
const Module = require('module')
if (!Module.isBuiltin) {
  Module.isBuiltin = mod => Module.builtinModules.includes(mod)
}

const nodeMajor = Number(process.versions.node.split('.')[0])

const names = fs.readdirSync(path.join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  .filter(file => file.endsWith('.js'))
  .map(file => file.slice(0, -3))

const instrumentations = names.reduce((acc, key) => {
  let instrumentations = []
  const name = key

  try {
    loadInstFile(`${name}/server.js`, instrumentations)
    loadInstFile(`${name}/client.js`, instrumentations)
  } catch (e) {
    loadInstFile(`${name}.js`, instrumentations)
  }

  instrumentations = instrumentations.filter(i => i.versions)
  if (instrumentations.length) {
    acc[key] = instrumentations
  }

  return acc
}, {})

const versions = {}

function checkYaml (yamlPath) {
  const yamlContent = yaml.parse(fs.readFileSync(yamlPath, 'utf8'))

  const rangesPerPluginFromYaml = {}
  const rangesPerPluginFromInst = {}
  for (const jobName in yamlContent.jobs) {
    const job = yamlContent.jobs[jobName]
    if (!job.env || !job.env.PLUGINS) continue

    const pluginName = job.env.PLUGINS
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
  for (const pluginName in rangesPerPluginFromYaml) {
    const yamlRanges = Array.from(rangesPerPluginFromYaml[pluginName])
    const instRanges = Array.from(rangesPerPluginFromInst[pluginName])
    const yamlVersions = getMatchingVersions(pluginName, yamlRanges)
    const instVersions = getMatchingVersions(pluginName, instRanges)
    if (!util.isDeepStrictEqual(yamlVersions, instVersions)) {
      const opts = { colors: true }
      const colors = x => util.inspect(x, opts)
      errorMsg(pluginName, 'Mismatch', `
Valid version ranges from YAML: ${colors(yamlRanges)}
Valid version ranges from INST: ${colors(instRanges)}
${mismatching(yamlVersions, instVersions)}
Note that versions may be dependent on Node.js version. This is Node.js v${colors(nodeMajor)}

> These don't match the same sets of versions in npm.
>
> Please check ${yamlPath} and the instrumentations
> for ${pluginName} to see that the version ranges match.`.trim())
    }
  }
}

function loadInstFile (file, instrumentations) {
  const instrument = {
    addHook (instrumentation) {
      instrumentations.push(instrumentation)
    }
  }

  const instPath = path.join(__dirname, `../packages/datadog-instrumentations/src/${file}`)

  proxyquire.noPreserveCache()(instPath, {
    './helpers/instrument': instrument,
    '../helpers/instrument': instrument
  })
}

function getRangesFromYaml (job) {
  // eslint-disable-next-line no-template-curly-in-string
  if (job.env && job.env.PACKAGE_VERSION_RANGE && job.env.PACKAGE_VERSION_RANGE !== '${{ matrix.range }}') {
    errorMsg(job.env.PLUGINS, 'ERROR in YAML', 'You must use matrix.range instead of env.PACKAGE_VERSION_RANGE')
    process.exitCode = 1
  }
  if (job.strategy && job.strategy.matrix && job.strategy.matrix.range) {
    const possibilities = [job.strategy.matrix]
    if (job.strategy.matrix.include) {
      possibilities.push(...job.strategy.matrix.include)
    }
    return possibilities.map(possibility => {
      if (possibility.range) {
        return [possibility.range].flat()
      } else {
        return undefined
      }
    }).flat()
  }

  return null
}

function getMatchingVersions (name, ranges) {
  if (!versions[name]) {
    versions[name] = JSON.parse(execSync('npm show ' + name + ' versions --json').toString())
  }
  return versions[name].filter(version => ranges.some(range => semver.satisfies(version, range)))
}

checkYaml(path.join(__dirname, '..', '.github', 'workflows', 'plugins.yml'))
checkYaml(path.join(__dirname, '..', '.github', 'workflows', 'appsec.yml'))

function mismatching (yamlVersions, instVersions) {
  const yamlSet = new Set(yamlVersions)
  const instSet = new Set(instVersions)

  const onlyInYaml = yamlVersions.filter(v => !instSet.has(v))
  const onlyInInst = instVersions.filter(v => !yamlSet.has(v))

  const opts = { colors: true }
  return [
    `Versions only in YAML: ${util.inspect(onlyInYaml, opts)}`,
    `Versions only in INST: ${util.inspect(onlyInInst, opts)}`
  ].join('\n')
}

function errorMsg (pluginName, title, message) {
  console.log('===========================================')
  console.log(title + ' for ' + pluginName)
  console.log('-------------------------------------------')
  console.log(message)
  console.log('\n')
  process.exitCode = 1
}
