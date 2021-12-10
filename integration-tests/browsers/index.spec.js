'use strict'

const { expect } = require('chai')
const { execSync, spawnSync } = require('child_process')
const { readFileSync, symlinkSync, mkdirSync, unlinkSync } = require('fs')
const { platform } = require('os')
const { resolve } = require('path')
const puppeteer = require('puppeteer')

// we can't use self import unfortunately for a few reasons so we setup our own local link
mkdirSync(resolve(__dirname, 'node_modules'), {
  recursive: true
})
// we have to recreate this everytime due to windows junctions being unsafe for
// move operations
try {
  unlinkSync(resolve(__dirname, 'node_modules', 'dd-trace'))
} catch (e) {
  if (e.code !== 'ENOENT') {
    throw e
  }
}
symlinkSync(
  resolve(__dirname, '..', '..'),
  resolve(__dirname, 'node_modules', 'dd-trace'),
  platform() === 'win32' ? 'junction' : 'file'
)

for (const buildCommand of [
  'npx rollup -c rollup.config.mjs --validate',
  'npx webpack --target web --output-filename webpack.js',
  'npx webpack --target node --output-filename webpack-node.js',
  'npx esbuild --bundle --outfile=./out/esbuild.js ./bundle-entrypoint.js',
  'npx esbuild --bundle --outfile=./out/esbuild-node.js --platform=node ./bundle-entrypoint.js'
]) {
  execSync(buildCommand, {
    cwd: __dirname
  })
}

function createTestForBundler (outFileLocation) {
  return async function () {
    this.timeout(20e3)

    const browser = await puppeteer.launch()
    const page = await browser.newPage()
    await page.goto('about:blank')

    const pageError = new Promise((resolve, reject) => {
      page.on('pageerror', reject)
    })
    const error = new Promise((resolve, reject) => {
      page.on('error', reject)
    })

    // eslint-disable-next-line
    const fn = eval(`() => {
      ${readFileSync(resolve(__dirname, outFileLocation), 'utf8')}
    }`)

    // execute standard javascript in the context of the page.
    const result = page.evaluate(fn)

    try {
      await Promise.race([
        result,
        pageError,
        error
      ])
      const typeofDDTrace = await page.evaluate(() => {
        return typeof this._ddtrace
      })

      expect(typeofDDTrace).to.equal('undefined')
    } finally {
      await browser.close()
    }
  }
}

function createTestForNode (outFileLocation) {
  return function () {
    this.timeout(20e3)

    const result = spawnSync('node', ['node-entrypoint.js', resolve(__dirname, outFileLocation)], {
      cwd: __dirname
    })

    if (result.status !== 0) {
      throw new Error(result.stderr.toString())
    }
  }
}

describe('bundlers for browsers and JS CDNs', () => {
  // these are the common bundlers JS CDNs use under the hood in various ways
  it('should perform a no-op instead of loading the tracer with webpack', createTestForBundler('./out/webpack.js'))
  it('should perform a no-op instead of loading the tracer with esbuild', createTestForBundler('./out/esbuild.js'))
  it('should perform a no-op instead of loading the tracer with rollup', createTestForBundler('./out/rollup.js'))

  // these will still be bloating the bundle, but shouldn't cause errors
  it('should perform a no-op instead of loading the tracer with webpack targeting node',
    createTestForBundler('./out/webpack-node.js'))
  it('should perform a no-op instead of loading the tracer with esbuild targeting node',
    createTestForBundler('./out/esbuild.js'))
})

describe('bundlers for servers', () => {
  it('should load the tracer with webpack', createTestForNode('./out/webpack-node.js'))
  it('should load the tracer with esbuild', createTestForNode('./out/esbuild-node.js'))
})
