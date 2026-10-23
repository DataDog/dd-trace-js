'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * @param {string} resourcePath
 */
function run (resourcePath) {
  const loader = require('../../src/loader')
  const source = fs.readFileSync(resourcePath, 'utf8')
  let result
  loader.call({
    callback (error, code) {
      if (error) throw error
      result = code
    },
    resourcePath,
  }, source)
  return result
}

function main () {
  delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
  if (process.argv[2] === 'disabled') {
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ai'
    require('../../../datadog-instrumentations/src/helpers/register')
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-disablement-'))
  try {
    const packageDir = path.join(directory, 'node_modules', 'ai')
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      main: 'dist/index.js',
      name: 'ai',
      version: '6.1.0',
    }))
    const sources = {
      'dist/index.js': [
        "function getTracer () { return 'original' }",
        'module.exports = { getTracer }',
        '',
      ].join('\n'),
      'dist/index.mjs': "export function getTracer () { return 'original' }\n",
    }
    const resourcePaths = []
    for (const [filePath, source] of Object.entries(sources)) {
      const resourcePath = path.join(packageDir, filePath)
      fs.writeFileSync(resourcePath, source)
      resourcePaths.push(resourcePath)
    }

    process.stdout.write(JSON.stringify(resourcePaths.map(run)))
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

main()
