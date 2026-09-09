'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const loader = require('../../src/loader')
const {
  applyDatadogTurbopack,
  cleanup,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('../helpers')

const WARNING_LIMIT = 128

async function main () {
  const projectDir = createProject()
  const files = []
  for (let index = 0; index <= WARNING_LIMIT; index++) {
    const packageDir = createPackage(projectDir, `copy-${index}/node_modules/ioredis`, {
      main: 'index.js',
      name: 'ioredis',
      version: '5.0.0',
    })
    files.push(write(packageDir, 'index.js', `module.exports = ${index}\n`))
  }

  try {
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const warnings = []
    for (let index = 0; index < files.length; index++) {
      const source = `module.exports = ${index + 1}\n`
      fs.writeFileSync(files[index], source)
      await runLoader(files[index], source, options, warning => warnings.push(warning))
      if (index === WARNING_LIMIT - 2) assert.equal(warnings.length, WARNING_LIMIT - 1)
      if (index === WARNING_LIMIT - 1) assert.equal(warnings.length, WARNING_LIMIT)
      if (index === WARNING_LIMIT) assert.equal(warnings.length, WARNING_LIMIT)
    }
  } finally {
    cleanup()
  }
}

/**
 * @param {string} resourcePath
 * @param {string} source
 * @param {object} options
 * @param {(warning: Error) => void} emitWarning
 * @returns {Promise<void>}
 */
function runLoader (resourcePath, source, options, emitWarning) {
  return new Promise((resolve, reject) => {
    loader.call({
      async: () => error => error ? reject(error) : resolve(),
      emitWarning,
      getOptions: () => options,
      resourcePath,
    }, source)
  })
}

main().catch(error => {
  process.nextTick(() => { throw error })
})
