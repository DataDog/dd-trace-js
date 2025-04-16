'use strict'

// Converted to JS from https://github.com/Asana/push-signed-commits/blob/main/create_commits.py

const { capture, run } = require('./terminal')

/**
 * Get the contents of a file at a specific commit, encoded as a base64 string.
 *
 * @param {string} commitHash The hash of the commit.
 * @param {string} filename The name of the file.
 *
 * @returns {string} The contents of the file, encoded in utf-8
 */
function getFileContentsAtCommit (commitHash, filename) {
  const textContents = capture(`git show ${commitHash}:${filename}`)

  return Buffer.from(textContents).toString('base64')
}

/**
 * Create a file changes object for a specific commit.
 *
 * @param {string} commitHash The hash of the commit.
 *
 * @returns {array} A dictionary representing the FileChanges object.
 */
function getFileChangesFromLocalCommitHash (commitHash) {
  const result = capture(`git diff --name-status ${commitHash}`)
  const filesChangedByCommit = result.split('\n').filter(c => c)
  const additions = []
  const deletions = []

  for (const fileChangeLine of filesChangedByCommit) {
    const [status, ...filenames] = fileChangeLine.split('\t')

    if (status === 'A' || status === 'M') {
      additions.push({
        path: filenames[filenames.length - 1],
        contents: getFileContentsAtCommit(commitHash, filenames[0])
      })
    } else if (status.includes('R')) {
      const oldName = filenames[0]
      const newName = filenames[1]

      deletions.push({ path: oldName })
      additions.push({
        path: newName,
        contents: getFileContentsAtCommit(commitHash, newName)
      })
    } else if (status === 'D') {
      deletions.push({ path: filenames[0] })
    }
  }

  return { additions, deletions }
}

function getLocalCommitsNotOnRemote (localBranchName, remoteName, remoteBranchName) {
  const result = capture(`git rev-list ${remoteName}/${remoteBranchName}..${localBranchName}`).split('\n')

  return result.filter(c => c).reverse()
}

async function createCommitOnRemoteBranch (
  githubToken, repositoryNameWithOwner, remoteBranchName, expectedHeadOid, fileChanges, message
) {
  const url = 'https://api.github.com/graphql'
  const headers = { Authorization: `Bearer ${githubToken}` }

  const mutation = `
    mutation ($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
        }
      }
    }
  `

  const graphqlInput = {
    branch: {
      repositoryNameWithOwner,
      branchName: remoteBranchName
    },
    expectedHeadOid,
    fileChanges,
    message
  }

  const data = {
    query: mutation,
    variables: { input: graphqlInput }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data)
  })

  return JSON.stringify(response).data.createCommitOnBranch.commit.oid
}

function fetchRemoteBranchAndGetHeadOid (remoteName, remoteBranchName) {
  run(`git fetch ${remoteName}`)

  return capture(`git rev-parse ${remoteName}/${remoteBranchName}`)
}

function pushSignedCommits (githubToken, repositoryNameWithOwner, localBranchName, remoteName, remoteBranchName) {
  const mergeBaseCommitOid = capture(`git merge-base ${localBranchName} ${remoteName}/${remoteBranchName}`)

  if (fetchRemoteBranchAndGetHeadOid(remoteName, remoteBranchName) !== mergeBaseCommitOid) {
    const remote = `${remoteName}/${remoteBranchName}`

    throw new Error(
      `The remote branch ${remote} has diverged from the local branch ${localBranchName}. Aborting.`
    )
  }

  const newCommitLocalHashes = getLocalCommitsNotOnRemote(localBranchName, remoteName, remoteBranchName)
  const newCommitsToCreate = []

  console.log(newCommitLocalHashes)
  for (const localCommitHash of newCommitLocalHashes) {
    const commitMessage = capture(`git log --format=%B -n 1 ${localCommitHash}`)
    const fileChanges = getFileChangesFromLocalCommitHash(localCommitHash)

    newCommitsToCreate.push({ localCommitHash, commitMessage, fileChanges })
  }

  console.log(newCommitsToCreate)
}

module.exports = {
  pushSignedCommits
}
