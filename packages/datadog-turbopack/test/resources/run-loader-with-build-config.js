'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const loader = require('../../src/loader')

function run (resourcePath, options) {
  const source = fs.readFileSync(resourcePath, 'utf8')
  return new Promise((resolve, reject) => {
    loader.call({
      async: () => (error, code) => error ? reject(error) : resolve(code),
      getOptions: () => options,
      getResolve: () => () => {
        throw new Error('Unexpected resolution')
      },
      resourcePath,
    }, source)
  })
}

async function main () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-disablement-'))
  try {
    const packageDir = path.join(directory, 'node_modules/ai')
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'ai',
      type: 'commonjs',
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
    const targets = {}
    for (const [filePath, source] of Object.entries(sources)) {
      const resourcePath = path.join(packageDir, filePath)
      fs.writeFileSync(resourcePath, source)
      resourcePaths.push(resourcePath)
      targets[fs.realpathSync(resourcePath).replaceAll('\\', '/')] = {
        esm: filePath.endsWith('.mjs'),
        payloads: [],
        rewriteTarget: { filePath, moduleName: 'ai' },
        sourceHash: createHash('sha256').update(source).digest('hex'),
      }
    }
    const serialized = JSON.stringify({
      compiler: { generator: '', parser: '', traverse: '' },
      components: {},
      dcPolyfill: require.resolve('dc-polyfill'),
      graphDependencies: [],
      relativeTargets: [],
      targets,
      version: 7,
    })
    const manifestPath = path.join(directory, `${createHash('sha256').update(serialized).digest('hex')}.json`)
    fs.writeFileSync(manifestPath, serialized)
    const options = { manifestPath, rewriteEdges: false, targetScope: 'direct' }
    const enabled = await Promise.all(resourcePaths.map(resourcePath => run(resourcePath, options)))
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ai'
    require('../../../datadog-instrumentations/src/helpers/register')
    const disabled = await Promise.all(resourcePaths.map(resourcePath => run(resourcePath, options)))
    process.stdout.write(JSON.stringify({ disabled, enabled }))
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

main()
