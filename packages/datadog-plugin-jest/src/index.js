const jestEnvironment = require('./jest-environment')
const jestJasmine2 = require('./jest-jasmine2')

module.exports = [].concat(jestEnvironment, jestJasmine2)
