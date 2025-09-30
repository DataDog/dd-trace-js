'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const path = require('path')

require('./setup/core')

const {
  getGitMetadataFromGitProperties,
  getGitHeadRef,
  getRemoteOriginURL,
  resolveGitHeadSHA,
  isValidCommitSHA,
} = require('../src/git_properties')

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

    it('filters out credentials', () => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=https://username:password@github.com/datadog/dd-trace-js.git
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('https://github.com/datadog/dd-trace-js.git')
    })

    it('ignores other fields', () => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
git.repository_url=git@github.com:DataDog/dd-trace-js.git
git.commit.user.email=user@email.com
      `)
      expect(commitSHA).to.equal('4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('ignores badly formatted files', () => {
      const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(`
git.commit.sha=; rm -rf ;
git.repository_url=; rm -rf ;
      `)
      expect(commitSHA).to.equal(undefined)
      expect(repositoryUrl).to.equal(undefined)
    })

    it('does not crash with empty files', () => {
      const emptyStringResult = getGitMetadataFromGitProperties('')
      expect(emptyStringResult.commitSHA).to.equal(undefined)
      expect(emptyStringResult.repositoryUrl).to.equal(undefined)
      const undefinedResult = getGitMetadataFromGitProperties(undefined)
      expect(undefinedResult.commitSHA).to.equal(undefined)
      expect(undefinedResult.repositoryUrl).to.equal(undefined)
    })
  })

  describe('getRemoteOriginURL', () => {
    it('reads repository URL from .git/config', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
url = git@github.com/DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com/DataDog/dd-trace-js.git')
    })

    it('filters out credentials', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
url = https://username:password@github.com/datadog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('https://github.com/datadog/dd-trace-js.git')
    })

    it('handles Windows-style line breaks (CRLF)', () => {
      const repositoryUrl = getRemoteOriginURL('[remote "origin"]\r\nurl = git@github.com:DataDog/dd-trace-js.git\r\n')
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('handles case-insensitive remote section names', () => {
      const repositoryUrl = getRemoteOriginURL(`
[REMOTE "Origin"]\n
url = git@github.com:DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('finds URL when it is not the first key-value pair', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
fetch = +refs/heads/*:refs/remotes/origin/*
push = +refs/heads/*:refs/heads/*
url = git@github.com:DataDog/dd-trace-js.git
mirror = false`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('ignores badly formatted files', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
url = rm -rf ;`)
      expect(repositoryUrl).to.equal(undefined)
    })

    it('handles URLs with no spaces around equals sign', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
url=git@github.com:DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('handles URLs with tabs and multiple spaces', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
\turl\t=\tgit@github.com:DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('handles case-insensitive URL key', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
URL = git@github.com:DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('handles mixed case URL key', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
Url = git@github.com:DataDog/dd-trace-js.git`)
      expect(repositoryUrl).to.equal('git@github.com:DataDog/dd-trace-js.git')
    })

    it('returns undefined when no origin remote section exists', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "upstream"]
url = git@github.com:upstream/dd-trace-js.git
[remote "fork"]
url = git@github.com:user/dd-trace-js.git`)
      expect(repositoryUrl).to.equal(undefined)
    })

    it('returns undefined when origin remote section has no URL', () => {
      const repositoryUrl = getRemoteOriginURL(`
[remote "origin"]
fetch = +refs/heads/*:refs/remotes/origin/*
push = +refs/heads/*:refs/heads/*`)
      expect(repositoryUrl).to.equal(undefined)
    })

    it('does not crash with empty files', () => {
      const repositoryUrl = getRemoteOriginURL('')
      expect(repositoryUrl).to.equal(undefined)
      const undefinedResult = getRemoteOriginURL(undefined)
      expect(undefinedResult).to.equal(undefined)
    })

    it('handles null input gracefully', () => {
      const repositoryUrl = getRemoteOriginURL(null)
      expect(repositoryUrl).to.equal(undefined)
    })
  })

  describe('getGitHeadRef', () => {
    it('reads HEAD ref from .git/HEAD', () => {
      const headRef = getGitHeadRef(`
        ref: refs/heads/main
      `)
      expect(headRef).to.equal('refs/heads/main')
    })

    it('ignores badly formatted files', () => {
      const headRef = getGitHeadRef(`
        ref: ; rm -rf ;
      `)
      expect(headRef).to.equal(undefined)
    })

    it('ignores other fields', () => {
      const headRef = getGitHeadRef(`
        git.commit.sha=4e7da8069bcf5ffc8023603b95653e2dc99d1c7d
        ref: refs/heads/main
        ref: ; rm -rf ;
      `)
      expect(headRef).to.equal('refs/heads/main')
    })

    it('does not crash with empty files', () => {
      const headRef = getGitHeadRef('')
      expect(headRef).to.equal(undefined)
      const undefinedResult = getGitHeadRef(undefined)
      expect(undefinedResult).to.equal(undefined)
    })
  })

  describe('isValidCommitSHA', () => {
    it('validate correct 40-character sha', () => {
      const validSHA = '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d'
      expect(isValidCommitSHA(validSHA)).to.equal(true)
    })

    it('rejects sha that is too short', () => {
      const invalidSHA = '4e7da8069bcf5ffc8023603b95653e2dc99d1c7'
      expect(isValidCommitSHA(invalidSHA)).to.equal(false)
    })

    it('rejects sha that is too long', () => {
      const invalidSHA = '4e7da8069bcf5ffc8023603b95653e2dc99d1c7da'
      expect(isValidCommitSHA(invalidSHA)).to.equal(false)
    })

    it('rejects sha with invalid characters', () => {
      const invalidSHA = '4e7da8069bcf5ffc8023603b95653e2dc99d1c7g'
      expect(isValidCommitSHA(invalidSHA)).to.equal(false)
    })

    it('rejects empty string', () => {
      expect(isValidCommitSHA('')).to.equal(false)
    })

    it('rejects null and undefined', () => {
      expect(isValidCommitSHA(null)).to.equal(false)
      expect(isValidCommitSHA(undefined)).to.equal(false)
    })
  })

  describe('resolveGitHeadSHA', () => {
    const DD_GIT_FOLDER_PATH = path.join(__dirname, 'fixtures', 'config', 'git-folder')
    const DD_GIT_FOLDER_DETACHED_PATH = path.join(__dirname, 'fixtures', 'config', 'git-folder-detached')
    const DD_GIT_FOLDER_INVALID_PATH = path.join(__dirname, 'fixtures', 'config', 'git-folder-invalid')

    it('returns SHA from ref file using fixture data', () => {
      const result = resolveGitHeadSHA(DD_GIT_FOLDER_PATH)
      expect(result).to.equal('964886d9ec0c9fc68778e4abb0aab4d9982ce2b5')
    })

    it('returns SHA from detached HEAD using fixture data', () => {
      const result = resolveGitHeadSHA(DD_GIT_FOLDER_DETACHED_PATH)
      expect(result).to.equal('964886d9ec0c9fc68778e4abb0aab4d9982ce2b5')
    })

    it('returns undefined when git folder does not exist', () => {
      const result = resolveGitHeadSHA('/nonexistent/path')
      expect(result).to.equal(undefined)
    })

    it('returns undefined when HEAD contains invalid content', () => {
      const result = resolveGitHeadSHA(DD_GIT_FOLDER_INVALID_PATH)
      expect(result).to.equal(undefined)
    })
  })
})
