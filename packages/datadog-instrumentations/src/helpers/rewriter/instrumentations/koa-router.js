'use strict'

const astQuery = 'BlockStatement > ReturnStatement[argument.callee.type="CallExpression"]' +
  '[argument.callee.arguments.0.name=/^(layerChain|middlewareChain)$/][argument.arguments.0.type="Identifier"]'

module.exports = [
  { name: 'koa-router', versionRange: '>=7', filePath: 'lib/router.js' },
  { name: '@koa/router', versionRange: '>=8 <15', filePath: 'lib/router.js' },
  { name: '@koa/router', versionRange: '>=15', filePath: 'dist/index.js' },
  { name: '@koa/router', versionRange: '>=15', filePath: 'dist/index.mjs' },
].map(module => ({ module, astQuery, transform: 'publishKoaRouterDispatch', channelName: 'dispatch' }))
