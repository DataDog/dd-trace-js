// non default name so that it only gets picked up intentionally
module.exports = {
  exclude: ['node_modules/**', 'ci-visibility/test/failing-test.js'],
  include: process.env.NYC_INCLUDE ? JSON.parse(process.env.NYC_INCLUDE) : ['ci-visibility/test/**']
}
