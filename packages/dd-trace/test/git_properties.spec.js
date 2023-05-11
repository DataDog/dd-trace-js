require('./setup/tap')

const { getGitMetadataFromGitProperties } = require('../src/git_properties')

describe('git_properties', () => {
  describe('getGitMetadataFromGitProperties', () => {
    it('reads commit SHA and repository URL', () => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=git@github.com:DataDog/dd-trace-js.git
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })
  })
})
