'use strict'

const esmHook = require('../src/esm-hook')
const { execSync } = require('child_process')
const path = require('path')
const { expect } = require('chai')

const loaderHook = path.join(__dirname, '..', '..', '..', 'loader-hook.mjs')

const testing = process.env.ESM_HOOK_TEST

if (testing) {
  esmHook(['express', 'os'], (exports, name, baseDir) => {
    if (name === 'express') {
      return function express () {
        return {
          typeofExportsDefault: typeof exports.default,
          name,
          baseDir
        }
      }
    }
    if (name === 'os') {
      exports.freemem = () => 42
    }
  })
  ;(async () => {
    const { default: expressDefault } = await import('express')
    const { freemem } = await import('os')
    console.log({
      express: expressDefault(),
      freemem: freemem()
    })
  })()
} else {
  describe.only('esm-hook', () => {
    let output
    context('with loader hook', () => {
      before(() => {
        output = JSON.parse(execSync(`node --no-warnings --loader=${loaderHook} ${__filename}`, {
          env: Object.assign({}, process.env, { ESM_HOOK_TEST: 'yes' })
        }).toString())
      })
      it('should receive exports from instrumented module', () => {
        expect(output.express.typeofExportsDefault).to.equal('function')
      })
    })
  })
}
