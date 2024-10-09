const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')

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

const matricesJson = require(matricesPath)

const versionsJson = require(versionsPath)
const versionsNames = Object.getOwnPropertyNames(yaml.load(fs.readFileSync(versionsPath, 'utf-8')).matrices)

function generateMatrix () {
  let versionsPlugin
  let matrix

  for (const name of versionsNames) {
    // object is by plugin name
    // it has the properties of min-version the minimum version we support
    // and it has node-versions tracking version support by node version where applicable
    // the first node version will be nested as node-version and range, subsequent node version
    // ranges will need to be nested within 'include:'
    // if the plugin does not require a node version it will just have a range

    versionsPlugin = versionsJson.matrices[name]

    if (versionsPlugin['by-node-version'] === true) {
      matrix = {
        'node-version': [],
        range: [],
        include: {}
      }
      const range = []
      const plugin = versionsPlugin['node-versions']
      for (const version in plugin) {
        range.push({ 'node-version': +version, range: plugin[version] })
      }

      for (let ele = 0; ele < range.length; ele++) {
        if (ele === 0) {
          matrix['node-version'] = [range[ele]['node-version']]
          matrix.range = range[ele].range
        } else {
          matrix.include = [{
            'node-version': range[ele]['node-version'],
            range: range[ele].range[0]
          }]
        }
      }
      matricesJson.matrices[name] = matrix
    } else {
      matrix = {
        range: versionsPlugin.range
      }
      matricesJson.matrices[name] = matrix
    }
  }
  return matricesJson
}

module.exports = {
  generateMatrix
}

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(generateMatrix()))
}
