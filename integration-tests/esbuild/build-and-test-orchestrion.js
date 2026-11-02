#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const esbuild = require('esbuild')

const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const format = process.argv[2] || 'cjs'
const extension = format === 'esm' ? 'mjs' : 'js'
const outfile = path.join(__dirname, `orchestrion-out.${extension}`)

esbuild.build({
  entryPoints: [path.join(__dirname, `basic-test-orchestrion.${extension}`)],
  bundle: true,
  outfile,
  format,
  platform: 'node',
  sourcemap: true,
  plugins: [ddPlugin],
}).then(() => {
  const map = JSON.parse(fs.readFileSync(`${outfile}.map`, 'utf8'))
  const packageDir = path.dirname(require.resolve('@langchain/langgraph/package.json'))
  const targetPath = path.join(packageDir, `dist/pregel/index.${format === 'esm' ? 'js' : 'cjs'}`)
  const sourceIndex = map.sources.findIndex(source => path.resolve(__dirname, source) === targetPath)
  assert.notEqual(sourceIndex, -1, 'source map should point to the original rewrite target')
  assert.equal(map.sourcesContent[sourceIndex], fs.readFileSync(targetPath, 'utf8'))

  const { status, stderr } = spawnSync(process.execPath, [outfile], { encoding: 'utf8' })
  assert.equal(status, 0, stderr)
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(`${outfile}.map`, { force: true })
})
