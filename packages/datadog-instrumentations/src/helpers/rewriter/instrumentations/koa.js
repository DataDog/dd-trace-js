'use strict'

const astQuery = 'BlockStatement > ReturnStatement[argument.callee.type="CallExpression"]' +
  '[argument.callee.arguments.0.name=/^(layerChain|middlewareChain)$/][argument.arguments.0.type="Identifier"]'

const factoryQuery = 'AssignmentExpression[left.object.object.name=Router][left.object.property.name=prototype]' +
  '[left.property.name=allowedMethods] > FunctionExpression.right, ' +
  'MethodDefinition[key.name=allowedMethods] > FunctionExpression.value'

const routers = [
  { name: 'koa-router', versionRange: '>=7', filePath: 'lib/router.js' },
  { name: '@koa/router', versionRange: '>=8 <15', filePath: 'lib/router.js' },
  { name: '@koa/router', versionRange: '>=15', filePath: 'dist/index.js' },
  { name: '@koa/router', versionRange: '>=15', filePath: 'dist/index.mjs' },
].flatMap(module => [
  { module, astQuery, transform: 'publishKoaRouterDispatch', channelName: 'dispatch' },
  { module, astQuery: factoryQuery, functionQuery: { kind: 'Sync' }, channelName: 'allowedMethods' },
])

module.exports = [{
  module: { name: 'koa', versionRange: '>=3', filePath: 'lib/application.js' },
  astQuery: 'Program:has(VariableDeclarator[id.name=compose][init.arguments.0.value="koa-compose"]) ' +
    'MethodDefinition[key.name=callback] > FunctionExpression.value > ' +
    'BlockStatement.body > VariableDeclaration[kind=const][declarations.length=1]' +
    '[declarations.0.id.name=fn][declarations.0.init.callee.object.type=ThisExpression]' +
    '[declarations.0.init.callee.property.name=compose][declarations.0.init.callee.computed=false]' +
    '[declarations.0.init.arguments.length=1][declarations.0.init.arguments.0.object.type=ThisExpression]' +
    '[declarations.0.init.arguments.0.property.name=middleware]' +
    '[declarations.0.init.arguments.0.computed=false] ~ ReturnStatement[argument.name=handleRequest]',
  transform: 'publishKoaCallback',
  channelName: 'callback',
}, ...routers]
