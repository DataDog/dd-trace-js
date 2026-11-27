'use strict'

module.exports = ['dist/hono-base.js', 'dist/cjs/hono-base.js'].map(filePath => ({
  module: { name: 'hono', versionRange: '>=4', filePath },
  astQuery: 'ClassBody > MethodDefinition[key.name="addRoute"]',
  transform: 'publishHonoMiddlewareRoute',
  channelName: 'middlewareRoute',
}))
