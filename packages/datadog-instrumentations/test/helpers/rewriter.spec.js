// 'use strict'

// const { expect } = require('chai')
// const instrumentations = require('../../src/helpers/rewriter/instrumentations.json')

// describe('rewriter', () => {
//   before(() => {
//     instrumentations.push({
//       moduleName: 'test',
//       versionRange: '>=0.1.0',
//       filePath: 'index.js',
//       functionQuery: {
//         methodName: 'test',
//         className: 'Test'
//       },
//       operator: 'traceSync',
//       channelName: 'test'
//     })

//     require('../../src/helpers/rewriter/loader')
//   })

//   after(() => {
//     instrumentations.pop()
//   })

//   it('should rewrite stack traces with original locations', () => {
//     const { Test } = require('./rewriter/node_modules/test')
//     const test = new Test()

//     try {
//       test.test()
//     } catch (e) {
//       console.log(e)
//     }
//   })
// })
