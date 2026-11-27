'use strict'

const nextBody = 'BlockStatement > FunctionDeclaration[id.name="next"] > BlockStatement'
const astQuery = `:matches(${nextBody},${nextBody} > TryStatement > BlockStatement) > :matches(` +
  'ReturnStatement[argument.callee.property.name="process_params"]' +
    '[argument.arguments.length=5][argument.arguments.4.type="FunctionExpression"],' +
  'ExpressionStatement[expression.callee.property.name="process_params"]' +
    '[expression.arguments.length=5][expression.arguments.4.type="FunctionExpression"],' +
  'ExpressionStatement[expression.callee.name="processParams"]:matches(' +
    '[expression.arguments.length=6][expression.arguments.5.type="FunctionExpression"],' +
    '[expression.arguments.length=7][expression.arguments.6.type="FunctionExpression"]))'

module.exports = [
  { name: 'express', versionRange: '>=4.5 <5', filePath: 'lib/router/index.js' },
  { name: 'router', versionRange: '>=1', filePath: 'index.js' },
].map(module => ({ module, astQuery, transform: 'publishRouterParams', channelName: 'routeParams' }))
