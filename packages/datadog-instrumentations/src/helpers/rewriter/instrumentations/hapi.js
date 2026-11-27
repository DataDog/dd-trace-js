'use strict'

const astQuery = 'BlockStatement > IfStatement[test.object.object.object.type="ThisExpression"]' +
  '[test.object.object.property.name="route"][test.object.property.name="settings"][test.property.name="cors"]'

module.exports = [['hapi', '>=16'], ['@hapi/hapi', '>=17.9']].map(([name, versionRange]) => ({
  module: { name, versionRange, filePath: 'lib/request.js' },
  astQuery,
  transform: 'publishHapiRoute',
  channelName: 'routeLookup',
}))
