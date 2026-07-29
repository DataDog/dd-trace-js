'use strict'

const fs = require('node:fs')
const path = require('node:path')

const tracerRoot = path.join(__dirname, '..')
const sourceRoot = path.join(__dirname, 'serverless-preload')
const outputRoot = path.resolve(getOption('--output') || path.join(tracerRoot, 'build', 'serverless-preload'))
const esbuildPath = getOption('--esbuild')

if (!esbuildPath) {
  throw new Error('Pass --esbuild with the absolute path to an installed esbuild module')
}

const esbuild = require(path.resolve(esbuildPath))
const datadogPlugin = require(path.join(tracerRoot, 'esbuild'))

async function main () {
  fs.rmSync(outputRoot, { recursive: true, force: true })

  await esbuild.build({
    entryPoints: {
      initialize: path.join(sourceRoot, 'initialize.mjs'),
      'loader-hook': path.join(sourceRoot, 'loader-hook.mjs'),
    },
    outdir: outputRoot,
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    keepNames: true,
    minify: false,
    sourcemap: false,
    plugins: [datadogPlugin],
  })

  copyImportInTheMiddleRegister()
  writeTracerFacade()
  writeManifest()
}

function copyImportInTheMiddleRegister () {
  const source = require.resolve('import-in-the-middle/lib/register.js')
  const destination = path.join(outputRoot, 'lib', 'register.js')

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function writeTracerFacade () {
  const facadeRoot = path.join(outputRoot, 'node_modules', 'dd-trace')

  fs.mkdirSync(facadeRoot, { recursive: true })
  fs.writeFileSync(path.join(facadeRoot, 'index.js'), `'use strict'

const tracer = globalThis[Symbol.for('datadog:serverless:tracer')]
if (!tracer) throw new Error('Datadog serverless preload did not initialize')

module.exports = tracer
`)
  fs.writeFileSync(path.join(facadeRoot, 'package.json'), `${JSON.stringify({
    name: 'dd-trace',
    private: true,
    main: 'index.js',
  }, null, 2)}\n`)
}

function writeManifest () {
  const files = listFiles(outputRoot)
  const manifest = {
    schemaVersion: 1,
    tracerVersion: require('../package.json').version,
    nodeOptionsImport: './initialize.mjs',
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  }

  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

function listFiles (directory, root = directory) {
  const files = []

  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name)
    const stat = fs.statSync(file)

    if (stat.isDirectory()) {
      files.push(...listFiles(file, root))
    } else if (name !== 'manifest.json') {
      files.push({
        path: path.relative(root, file).replaceAll(path.sep, '/'),
        bytes: stat.size,
      })
    }
  }

  return files
}

function getOption (name) {
  const index = process.argv.indexOf(name)
  if (index === -1 || index + 1 === process.argv.length) return
  return process.argv[index + 1]
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
