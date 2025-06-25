const t = require('tap')
require('./setup/core')

const { getGitMetadataFromGitProperties } = require('../src/git_properties')

t.test('git_properties', t => {
  context('getGitMetadataFromGitProperties', () => {
    t.test('reads commit SHA and repository URL', t => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=git@github.com:DataDog/dd-trace-js.git
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
      t.end()
    })
    t.test('filters out credentials', t => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=https://username:password@github.com/datadog/dd-trace-js.git
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('https://github.com/datadog/dd-trace-js.git')
      t.end()
    })
    t.test('ignores other fields', t => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=git@github.com:DataDog/dd-trace-js.git
git.commit.user.email=user@email.com
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
      t.end()
    })
    t.test('ignores badly formatted files', t => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=; rm -rf ;
git.repository_url=; rm -rf ;
      `)
      expect(commitSHA).to.equal(undefined)
      expect(repositoryUrl).to.equal(undefined)
      t.end()
    })
    t.test('does not crash with empty files', t => {
      const emptyStringResult = getGitMetadataFromGitProperties('')
      expect(emptyStringResult.commitSHA).to.equal(undefined)
      expect(emptyStringResult.repositoryUrl).to.equal(undefined)
      const undefinedResult = getGitMetadataFromGitProperties(undefined)
      expect(undefinedResult.commitSHA).to.equal(undefined)
      expect(undefinedResult.repositoryUrl).to.equal(undefined)
      t.end()
    })
  })
  t.end()
})
