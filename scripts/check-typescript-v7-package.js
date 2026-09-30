'use strict'

const { execFileSync } = require('node:child_process')
const { copyFileSync, cpSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const fixture = path.join(__dirname, 'fixtures/typescript-v7-consumer')
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'dd-trace-typescript-v7-'))
const consumer = path.join(temporaryDirectory, 'consumer')

try {
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', temporaryDirectory], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  cpSync(fixture, consumer, { recursive: true })
  copyFileSync(path.join(temporaryDirectory, tarball), path.join(consumer, 'dd-trace.tgz'))
  execFileSync('yarn', ['install', '--ignore-scripts'], { cwd: consumer, stdio: 'inherit' })

  for (const configuration of ['tsconfig-node-next.json', 'tsconfig-bundler.json']) {
    execFileSync(process.execPath, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', configuration], {
      cwd: consumer,
      stdio: 'inherit',
    })
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
