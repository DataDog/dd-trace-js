'use strict'

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const proxyquire = require('proxyquire')

const versionLists = {}
const names = []

const filter = process.env.hasOwnProperty('PLUGINS') && process.env.PLUGINS.split('|')

fs.readdirSync(path.join(__dirname, '../../packages/datadog-instrumentations/src'))
  .filter(file => file.endsWith('js'))
  .forEach(file => {
    file = file.replace('.js', '')

    if (!filter || filter.includes(file)) {
      names.push(file)
    }
  })

async function getVersionList (name) {
  if (versionLists[name]) {
    return versionLists[name]
  }
  const list = await npmView(`${name} versions`)
  versionLists[name] = list
  return list
}

function npmView (input) {
  return new Promise((resolve, reject) => {
    childProcess.exec(`npm view ${input} --json`, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(JSON.parse(stdout.toString('utf8')))
    })
  })
}

function loadInstFile (file, instrumentations) {
  const instrument = {
    addHook (instrumentation) {
      instrumentations.push(instrumentation)
    }
  }

  const instPath = path.join(__dirname, `../../packages/datadog-instrumentations/src/${file}`)

  proxyquire.noPreserveCache()(instPath, {
    './helpers/instrument': instrument,
    '../helpers/instrument': instrument
  })
}

function getInternals () {
  return names.map(key => {
    const instrumentations = []
    const name = key

    try {
      loadInstFile(`${name}/server.js`, instrumentations)
      loadInstFile(`${name}/client.js`, instrumentations)
    } catch (e) {
      loadInstFile(`${name}.js`, instrumentations)
    }

    return instrumentations
  }).reduce((prev, next) => prev.concat(next), [])
}

module.exports = {
  getVersionList,
  npmView,
  loadInstFile,
  getInternals
}
