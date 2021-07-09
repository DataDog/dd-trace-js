'use strict'

const fs = require('fs/promises')
const path = require('path')

const SIRUN_DIR = path.join(__dirname, '..', 'benchmark', 'sirun')
const PLUGIN_DIR = path.join(__dirname, '..', 'packages')

let sirunBenchmarks

async function getSirunBenchmarks () {
  if (sirunBenchmarks) return sirunBenchmarks
  sirunBenchmarks = (await fs.readdir(SIRUN_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory()).map(d => d.name)
  return sirunBenchmarks
}

async function sirunBenchmarkDefs () {
  const benchmarks = await getSirunBenchmarks()
  let result = ''
  for (const benchmark of benchmarks) {
    result += `  node-bench-sirun-${benchmark}-latest:
    <<: *node-bench-sirun-base
    docker:
      - image: node
        environment:
          - SIRUN_TEST_DIR=${benchmark}
`
    if (benchmark.startsWith('plugin-')) {
      result += `          - PLUGINS=${benchmark.replace('plugin-', '')}
`
    }
    result += '\n'
  }
  return result
}

async function sirunBenchmarkList (padding) {
  return (await getSirunBenchmarks())
    .map(b => `${padding}- node-bench-sirun-${b}-latest`)
    .join('\n')
}

let plugins
async function getPlugins () {
  if (plugins) return plugins
  plugins = (await fs.readdir(PLUGIN_DIR))
    .filter(d => d.startsWith('datadog-plugin-') && d !== 'datadog-plugin-fs')
    .map(p => p.replace('datadog-plugin-', ''))
  return plugins
}

async function getPluginUnitDef (plugin) {
  try {
    const unitYml = path.join(PLUGIN_DIR, `datadog-plugin-${plugin}`, 'test', 'unit.yml')
    return await fs.readFile(unitYml, 'utf8')
  } catch (e) {
    return `  node-${plugin}:
    <<: *node-plugin-base
    docker:
      - image: node:12
        environment:
          - PLUGINS=${plugin}`
  }
}

async function getPluginUnitDefs () {
  const plugins = await getPlugins()
  return (await Promise.all(plugins.map(getPluginUnitDef))).join('\n\n\n')
}

async function pluginUnitList (padding) {
  return (await getPlugins())
    .map(plugin => `${padding}${plugin === 'limitd-client' ? '# ' : ''}- node-${plugin}`)
    .join('\n')
}

async function main () {
  let yaml = await fs.readFile(path.join(__dirname, 'helpers', 'circle-template.yml'), 'utf8')
  yaml = yaml.replace('SIRUN_BENCHMARK_DEFINITIONS', await sirunBenchmarkDefs())
  yaml = yaml.replace(/SIRUN_LIST_6/g, await sirunBenchmarkList('      '))
  yaml = yaml.replace(/SIRUN_LIST_12/g, await sirunBenchmarkList('            '))
  yaml = yaml.replace(/PLUGIN_UNIT_TESTS/g, await getPluginUnitDefs())
  yaml = yaml.replace(/PLUGIN_LIST_6/g, await pluginUnitList('      '))
  yaml = yaml.replace(/PLUGIN_LIST_12/g, await pluginUnitList('            '))
  console.log(yaml) // eslint-disable-line no-console
}

main()
