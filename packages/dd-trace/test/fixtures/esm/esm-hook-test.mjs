import esmHook from '../../../src/esm-hook.js'

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
  const expressResult = expressDefault()
  const express = typeof expressResult === 'function' ? 'express()' : expressResult
  console.log(JSON.stringify({
    express,
    freemem: freemem()
  }))
})()
