'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const v8 = require('node:v8')

const rewriter = require('../../../datadog-instrumentations/src/helpers/rewriter')

let retired
let active
let created = 0
rewriter.createBundlerRewriter = () => {
  const buildRewriter = (content, _filename, _format, _target, sourceMap) => ({ code: content, map: sourceMap })
  if (created++ === 0) retired = new WeakRef(buildRewriter)
  else active = new WeakRef(buildRewriter)
  return buildRewriter
}

const loader = require('../../src/loader')

async function run (fixture) {
  const source = fs.readFileSync(fixture.resourcePath, 'utf8')
  await new Promise((resolve, reject) => {
    loader.call({
      async: () => error => error ? reject(error) : resolve(),
      getOptions: () => fixture.options,
      getResolve: () => () => {
        throw new Error('Unexpected resolution')
      },
      resourcePath: fixture.resourcePath,
    }, source)
  })
}

async function main () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-context-'))
  try {
    const fixtures = []
    for (let index = 0; index < 2; index++) {
      const resourcePath = path.join(directory, String(index), 'node_modules/ioredis/index.js')
      const source = `module.exports = ${index}`
      fs.mkdirSync(path.dirname(resourcePath), { recursive: true })
      fs.writeFileSync(resourcePath, source)
      fs.writeFileSync(path.join(path.dirname(resourcePath), 'package.json'), JSON.stringify({
        name: 'ioredis',
        version: '5.0.0',
      }))
      const plan = {
        compiler: { generator: '', parser: '', traverse: '' },
        components: {},
        dcPolyfill: require.resolve('dc-polyfill'),
        graphDependencies: [],
        relativeTargets: [],
        targets: {
          [fs.realpathSync(resourcePath).replaceAll('\\', '/')]: {
            esm: false,
            payloads: [],
            rewriteTarget: { filePath: 'index.js', moduleName: 'ioredis' },
            sourceHash: createHash('sha256').update(source).digest('hex'),
          },
        },
        version: 7,
      }
      const serialized = JSON.stringify(plan)
      const manifestPath = path.join(directory, `${createHash('sha256').update(serialized).digest('hex')}.json`)
      fs.writeFileSync(manifestPath, serialized)
      fixtures.push({
        options: { manifestPath, rewriteEdges: false, targetScope: 'direct' },
        resourcePath,
      })
    }

    await run(fixtures[0])
    await run(fixtures[1])
    await new Promise(resolve => setImmediate(resolve))
    global.gc()
    const snapshot = path.join(os.tmpdir(), `dd-turbopack-${process.pid}.heapsnapshot`)
    v8.writeHeapSnapshot(snapshot)
    fs.unlinkSync(snapshot)
    assert.equal(retired.deref(), undefined)
    assert.equal(typeof active.deref(), 'function')
    process.stdout.write('released')
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

main()
