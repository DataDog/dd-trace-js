module.exports = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    '**/ci-visibility/test/ci-visibility-test*'
  ]
}
