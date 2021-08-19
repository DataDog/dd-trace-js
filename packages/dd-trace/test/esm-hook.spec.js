'use strict'

const { execSync } = require('child_process')
const path = require('path')
const semver = require('semver')
const { expect } = require('chai')

const loaderHook = path.join(__dirname, '..', '..', '..', 'loader-hook.mjs')
const testFile = path.join(__dirname, 'fixtures', 'esm', 'esm-hook-test.mjs')

const supported = semver.satisfies(process.versions.node, '^12.20.0 || >=14.13.1')

describe('esm-hook', () => {
  let output

  if (supported) {
    context('with loader hook', () => {
      before(() => {
        output = JSON.parse(
          execSync(
            `node --experimental-modules --no-warnings --loader=${loaderHook} ${testFile}`
          ).toString()
        )
      })

      it('should replace default exports', () => {
        expect(typeof output.express).to.equal('object')
      })

      it('should receive exports from instrumented module', () => {
        expect(output.express.typeofExportsDefault).to.equal('function')
      })

      it('should receive module name', () => {
        expect(output.express.name).to.equal('express')
      })

      it('should receive module baseDir', () => {
        expect(output.express.baseDir).to.equal(path.dirname(require.resolve('express')))
      })

      it('should replace non-default exports', () => {
        expect(output.freemem).to.equal(42)
      })
    })

    context('without loader hook', () => {
      before(() => {
        output = JSON.parse(execSync(`node ${testFile}`).toString())
      })

      it('should not replace default exports', () => {
        expect(output.express).to.equal('express()')
      })

      it('should not replace non-default exports', () => {
        expect(output.freemem).to.not.equal(42)
      })
    })
  } else {
    it('does nothing', () => {
      expect(require('../src/esm-hook')()).to.equal(undefined)
    })
  }
})
