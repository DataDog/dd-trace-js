'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const msgpack = require('@msgpack/msgpack')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const id = require('../../../src/id')
const { AgentlessCiVisibilityEncoder } = require('../../../src/encode/agentless-ci-visibility')
const gitUtils = require('../../../src/plugins/util/git')
const { removeInvalidMetadata } = require('../../../src/plugins/util/test')

const providerSha = 'a'.repeat(40)
const sourceSha = 'b'.repeat(40)

/**
 * @typedef {object} EncodedTestPayload
 * @property {{type: string, content: {meta: Record<string, string>}}[]} events
 * @property {{test_levels: Record<string, string | number>}} metadata
 */

/** @param {Record<string, string>} env */
function ciFor (env) {
  return proxyquire('../../../src/plugins/util/ci', {
    '../../config/helper': { getEnvironmentVariables: () => env },
  })
}

describe('provider PR merge identity', () => {
  /** @type {[string, Record<string, string>, boolean][]} */
  const cases = [
    ['GitHub PR merge ref', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: providerSha,
      GITHUB_REF: 'refs/pull/123/merge',
      GITHUB_EVENT_NAME: 'pull_request',
    }, true],
    ['GitHub PR review merge ref', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: providerSha,
      GITHUB_REF: 'refs/pull/123/merge',
      GITHUB_EVENT_NAME: 'pull_request_review',
    }, true],
    ['GitHub push', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: providerSha,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'push',
    }, false],
    ['GitHub pull_request_target', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: providerSha,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_BASE_REF: 'main',
    }, false],
    ['GitHub PR head ref', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: providerSha,
      GITHUB_REF: 'refs/pull/123/head',
      GITHUB_EVENT_NAME: 'pull_request',
    }, false],
    ['GitHub malformed SHA', {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'invalid',
      GITHUB_REF: 'refs/pull/123/merge',
      GITHUB_EVENT_NAME: 'pull_request',
    }, false],
    ['GitLab merged results', {
      GITLAB_CI: 'true',
      CI_COMMIT_SHA: providerSha,
      CI_MERGE_REQUEST_IID: '123',
      CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result',
    }, true],
    ['GitLab merge train', {
      GITLAB_CI: 'true',
      CI_COMMIT_SHA: providerSha,
      CI_MERGE_REQUEST_IID: '123',
      CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train',
    }, true],
    ['GitLab detached MR', {
      GITLAB_CI: 'true',
      CI_COMMIT_SHA: providerSha,
      CI_MERGE_REQUEST_IID: '123',
      CI_MERGE_REQUEST_EVENT_TYPE: 'detached',
    }, false],
    ['GitLab branch pipeline', { GITLAB_CI: 'true', CI_COMMIT_SHA: providerSha }, false],
    ['Azure PR merge', {
      TF_BUILD: 'true',
      BUILD_SOURCEVERSION: providerSha,
      BUILD_SOURCEBRANCH: 'refs/pull/123/merge',
      BUILD_REASON: 'PullRequest',
      SYSTEM_PULLREQUEST_SOURCECOMMITID: sourceSha,
    }, true],
    ['Azure branch build', {
      TF_BUILD: 'true',
      BUILD_SOURCEVERSION: providerSha,
      BUILD_SOURCEBRANCH: 'refs/heads/main',
      BUILD_REASON: 'IndividualCI',
    }, false],
    ['Azure PR without merge evidence', {
      TF_BUILD: 'true',
      BUILD_SOURCEVERSION: providerSha,
      BUILD_SOURCEBRANCH: 'refs/heads/feature',
      BUILD_REASON: 'PullRequest',
    }, false],
    ['Travis PR merge', {
      TRAVIS: 'true',
      TRAVIS_COMMIT: providerSha,
      TRAVIS_PULL_REQUEST_SHA: sourceSha,
      TRAVIS_EVENT_TYPE: 'pull_request',
      TRAVIS_PULL_REQUEST: '123',
    }, true],
    ['Travis push', {
      TRAVIS: 'true',
      TRAVIS_COMMIT: providerSha,
      TRAVIS_EVENT_TYPE: 'push',
      TRAVIS_PULL_REQUEST: 'false',
    }, false],
    ['Travis API build with PR context', {
      TRAVIS: 'true',
      TRAVIS_COMMIT: providerSha,
      TRAVIS_EVENT_TYPE: 'api',
      TRAVIS_PULL_REQUEST: '123',
    }, false],
    ['AppVeyor PR without merge evidence', {
      APPVEYOR: 'true',
      APPVEYOR_REPO_PROVIDER: 'github',
      APPVEYOR_REPO_COMMIT: providerSha,
      APPVEYOR_PULL_REQUEST_HEAD_COMMIT: sourceSha,
      APPVEYOR_PULL_REQUEST_NUMBER: '123',
    }, false],
    ['Bitbucket source SHA', {
      BITBUCKET_BUILD_NUMBER: '1',
      BITBUCKET_COMMIT: providerSha,
      BITBUCKET_PR_ID: '123',
    }, false],
  ]

  for (const [name, env, isMerge] of cases) {
    it(`reports a separate provider merge SHA only with positive evidence: ${name}`, () => {
      const metadata = removeInvalidMetadata(ciFor(env).getCIMetadata())
      assert.strictEqual(metadata['ci.git.merge_commit_sha'], isMerge ? providerSha : undefined)
      if (name === 'Azure PR merge') assert.strictEqual(metadata['git.commit.sha'], sourceSha)
    })
  }
})

describe('canonical checkout directory comparison', () => {
  for (const workspace of [
    'C:\\Users\\RUNNER~1\\workspace',
    'C:\\USERS\\RUNNERADMIN\\workspace',
  ]) {
    it(`does not mark a Windows alias of the checkout as custom: ${workspace}`, () => {
      const checkout = 'C:/Users/runneradmin/workspace'
      const canonical = 'C:\\Users\\runneradmin\\workspace'
      const realpathSync = sinon.stub().returns(workspace)
      realpathSync.native = sinon.stub().returns(canonical)
      /**
       * @param {string} command
       * @param {string[]} flags
       */
      const execute = (command, flags) => {
        if (flags.join(' ') === 'rev-parse --show-toplevel') return checkout
        if (flags.join(' ') === 'rev-parse HEAD') return sourceSha
        return ''
      }
      const { getGitMetadata } = proxyquire('../../../src/plugins/util/git', {
        fs: { realpathSync },
        path: path.win32,
        'node:child_process': { execFileSync: execute },
        './git-cache': { cachedExec: execute },
      })
      const metadata = getGitMetadata({ ciWorkspacePath: workspace })
      assert.strictEqual(metadata['git.checkout.root'], checkout)
      assert.strictEqual(metadata['ci.workspace_path'], workspace)
      assert.strictEqual(metadata['git.checkout.is_custom'], undefined)
    })
  }
})

describe('Windows Git repository paths', () => {
  for (const gitDir of ['../.git', 'C:../.git']) {
    it(`preserves the caller's directory for ${gitDir}`, () => {
      const env = { GIT_DIR: gitDir, GIT_WORK_TREE: '..', GIT_COMMON_DIR: '../.git', GIT_ALLOW_PROTOCOL: 'https' }
      const inherited = { ...env }
      const execute = sinon.stub().returns('')
      const utils = proxyquire('../../../src/plugins/util/git', {
        path: path.win32,
        '../../config/helper': { getEnvironmentVariables: () => env },
        'node:child_process': { execFileSync: execute },
        './git-cache': { cachedExec: execute },
      })
      const cwd = sinon.stub(process, 'cwd').returns('C:\\repo\\src')
      try {
        utils.getGitInformationDiscrepancy('C:\\repo')
        assert.ok(execute.called)
        for (const { args } of execute.getCalls()) {
          assert.strictEqual(args[2].cwd, 'C:\\repo')
          assert.deepStrictEqual(args[2].env, {
            GIT_DIR: 'C:\\repo\\.git',
            GIT_WORK_TREE: 'C:\\repo',
            GIT_COMMON_DIR: 'C:\\repo\\.git',
            GIT_ALLOW_PROTOCOL: 'https',
          })
        }
        assert.deepStrictEqual(env, inherited)
      } finally {
        cwd.restore()
      }
    })
  }
})

describe('selected checkout context', () => {
  let directory, originalCwd, root, nested, gitRoot, gitNested

  /**
   * @param {string} cwd
   * @param {string[]} flags
   * @param {string=} input
   */
  function git (cwd, flags, input) {
    return execFileSync('git', flags, { cwd, input, stdio: 'pipe' }).toString().trim()
  }

  /**
   * @param {string} cwd
   * @param {string} message
   */
  function createRepository (cwd, message) {
    fs.mkdirSync(cwd, { recursive: true })
    git(cwd, ['init', '--quiet', '-b', 'juan-fernandez/test'])
    git(cwd, ['fast-import', '--quiet'],
      'commit refs/heads/juan-fernandez/test\ncommitter Test <test@example.com> 1700000000 +0000\n' +
      `data ${message.length}\n${message}\nM 100644 inline file.txt\ndata 4\nfile\n\n`)
    git(cwd, ['reset', '--hard', 'HEAD'])
    git(cwd, ['config', 'remote.origin.url', 'https://example.com/customer.git'])
    return git(cwd, ['rev-parse', 'HEAD'])
  }

  beforeEach(() => {
    originalCwd = process.cwd()
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-checkout-context-')))
    root = path.join(directory, 'root')
    nested = path.join(root, 'tools')
    createRepository(root, 'outer')
    createRepository(nested, 'inner')
    gitRoot = git(root, ['rev-parse', '--show-toplevel'])
    gitNested = git(nested, ['rev-parse', '--show-toplevel'])
  })

  afterEach(() => {
    process.chdir(originalCwd)
    sinon.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  for (const scenario of ['relative', 'absolute', 'mixed', 'common directory', 'gitfile', 'symlink parent']) {
    it(`preserves ${scenario} Git repository paths from a project subdirectory`, () => {
      const subdirectory = path.join(root, 'src')
      fs.mkdirSync(subdirectory)
      const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' }
      env.GIT_DIR = scenario === 'absolute' || scenario === 'common directory' ? path.join(root, '.git') : '../.git'
      env.GIT_WORK_TREE = scenario === 'absolute' || scenario === 'mixed' ? root : '..'
      if (scenario === 'common directory') env.GIT_COMMON_DIR = '../.git'
      let selected = root
      if (scenario === 'gitfile') {
        fs.writeFileSync(path.join(subdirectory, 'checkout.git'), `gitdir: ${path.join(root, '.git')}\n`)
        env.GIT_DIR = 'checkout.git'
      }
      if (scenario === 'symlink parent') {
        const target = path.join(nested, 'src')
        fs.mkdirSync(target)
        fs.symlinkSync(target, path.join(root, 'alias'), 'junction')
        env.GIT_DIR = '../alias/../.git'
        env.GIT_WORK_TREE = '../alias/..'
        selected = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: subdirectory, env, stdio: 'pipe',
        }).toString().trim()
      }
      const inherited = { ...env }
      const selectedSha = git(selected, ['rev-parse', 'HEAD'])
      const selectedRoot = git(selected, ['rev-parse', '--show-toplevel'])
      git(selected, ['update-ref', 'refs/remotes/origin/main', selectedSha])
      process.chdir(subdirectory)
      const utils = proxyquire('../../../src/plugins/util/git', {
        '../../config/helper': { getEnvironmentVariables: () => env },
      })
      const metadata = utils.getGitMetadata({ ciWorkspacePath: root })
      assert.strictEqual(metadata['git.checkout.root'], selectedRoot)
      assert.strictEqual(metadata['git.commit.sha'], selectedSha)
      assert.strictEqual(metadata['git.branch'], 'juan-fernandez/test')
      assert.strictEqual(metadata['git.commit.author.name'], 'Test')
      assert.strictEqual(metadata['git.repository_url'], 'https://example.com/customer.git')
      assert.deepStrictEqual(utils.getGitInformationDiscrepancy(selectedRoot), {
        gitRepositoryUrl: 'https://example.com/customer.git', gitCommitSHA: selectedSha,
      })
      assert.deepStrictEqual(utils.getLocalBranches('origin', selectedRoot), ['origin/main'])
      utils.checkAndFetchBranch('main', 'origin', selectedRoot)
      assert.strictEqual(utils.getMergeBase('origin/main', selectedSha, selectedRoot), selectedSha)
      assert.strictEqual(utils.hasLocalGitObject(selectedSha, selectedRoot), true)
      const commits = utils.getLatestCommits(selectedSha, selectedRoot)
      assert.deepStrictEqual(commits, [selectedSha])
      const objects = utils.getCommitsRevList([], commits, false, selectedRoot)
      assert.ok(objects.includes(selectedSha))
      assert.deepStrictEqual(utils.getCommitsRevList([], commits, true, selectedRoot), objects)
      const packs = utils.generatePackFilesForCommits(objects, selectedRoot)
      try {
        assert.strictEqual(packs.length, 1)
        const contents = git(selected, ['verify-pack', '-v', packs[0].replace(/\.pack$/, '.idx')])
        assert.match(contents, new RegExp(`^${selectedSha} commit `, 'm'))
      } finally {
        for (const pack of packs) {
          fs.rmSync(pack, { force: true })
          fs.rmSync(pack.replace(/\.pack$/, '.idx'), { force: true })
        }
      }
      assert.deepStrictEqual(env, inherited)
    })
  }

  for (const recovery of ['unshallow', 'head fetch', 'branch fetch']) {
    it(`preserves relative Git paths and inherited transport policy during ${recovery}`, () => {
      const parentSha = git(root, ['rev-parse', 'HEAD'])
      git(root, ['fast-import', '--quiet'],
        'commit refs/heads/juan-fernandez/test\ncommitter Test <test@example.com> 1700000001 +0000\n' +
        `data 4\nhead\nfrom ${parentSha}\nM 100644 inline file.txt\ndata 4\nhead\n\n`)
      git(root, ['update-ref', 'refs/heads/juan-fernandez/base', parentSha])
      const checkout = path.join(directory, 'recovery')
      git(directory, ['clone', '--quiet', '--depth=1', '--branch', 'juan-fernandez/test',
        pathToFileURL(root).href, checkout])
      const subdirectory = path.join(checkout, 'src')
      fs.mkdirSync(subdirectory)
      process.chdir(subdirectory)
      const env = {
        ...process.env,
        GIT_DIR: '../.git',
        GIT_WORK_TREE: '..',
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
      }
      const inherited = { ...env }
      const utils = proxyquire('../../../src/plugins/util/git', {
        '../../config/helper': { getEnvironmentVariables: () => env },
      })
      assert.strictEqual(utils.hasLocalGitObject(parentSha, checkout), false)
      if (recovery === 'unshallow') utils.unshallowRepository(true, undefined, checkout)
      else if (recovery === 'head fetch') utils.fetchHeadCommitSha(parentSha, true, checkout)
      else utils.checkAndFetchBranch('juan-fernandez/base', 'origin', checkout)
      assert.strictEqual(utils.hasLocalGitObject(parentSha, checkout), true)
      assert.strictEqual(git(checkout, ['rev-parse', `${parentSha}^{commit}`]), parentSha)
      assert.deepStrictEqual(env, inherited)
    })
  }

  it('selects the nested clone even when both clones use the same remote URL', () => {
    process.chdir(nested)
    const metadata = gitUtils.getGitMetadata({ ciWorkspacePath: root })
    assert.strictEqual(metadata['git.checkout.root'], gitNested)
    assert.strictEqual(metadata['git.checkout.is_custom'], 'true')
    assert.strictEqual(metadata['ci.workspace_path'], root)
    assert.strictEqual(metadata['git.commit.sha'], git(nested, ['rev-parse', 'HEAD']))
    assert.notStrictEqual(metadata['git.commit.sha'], git(root, ['rev-parse', 'HEAD']))
  })

  it('does not mark an ordinary project subdirectory as a custom checkout', () => {
    const subdirectory = path.join(root, 'src')
    fs.mkdirSync(subdirectory)
    process.chdir(subdirectory)
    const metadata = gitUtils.getGitMetadata({ ciWorkspacePath: root })
    assert.strictEqual(metadata['git.checkout.root'], gitRoot)
    assert.strictEqual(metadata['git.checkout.is_custom'], undefined)
  })

  it('compares canonical directories so workspace symlinks do not imply a custom checkout', () => {
    const alias = path.join(directory, 'alias')
    fs.symlinkSync(root, alias, 'junction')
    process.chdir(root)
    const metadata = gitUtils.getGitMetadata({ ciWorkspacePath: alias })
    assert.strictEqual(metadata['git.checkout.root'], gitRoot)
    assert.strictEqual(metadata['git.checkout.is_custom'], undefined)
    assert.strictEqual(metadata['ci.workspace_path'], alias)
  })

  for (const scenario of [
    { name: 'mirrored GitLab checkout', matched: true },
    { name: 'GitHub checkout', matched: true, github: true },
    { name: 'workspace symlink', matched: true, symlink: true },
    { name: 'tagged commit in a branch pipeline', matched: true, tagged: true },
    { name: 'missing CI branch', matched: true, missingBranch: true },
    { name: 'missing CI repository', matched: true, missingRepository: true },
    { name: 'explicit overrides', matched: true, overrides: true },
    { name: 'different checkout revision', differentRevision: true },
    { name: 'nested checkout with matching revision', nested: true },
    { name: 'missing CI revision', missingRevision: true },
    { name: 'missing CI workspace', missingWorkspace: true },
    { name: 'attached checkout branch', attached: true },
    { name: 'GitLab release tag without local refs', matched: true, release: true },
    { name: 'GitHub release tag without local refs', matched: true, release: true, github: true },
    { name: 'GitLab release tag with ambiguous local refs', matched: true, release: true, ambiguousTags: true },
    {
      name: 'GitHub release tag with ambiguous local refs',
      matched: true,
      release: true,
      ambiguousTags: true,
      github: true,
    },
    { name: 'CI release tag disambiguates a unique local tag', matched: true, release: true, tagged: true },
    { name: 'explicit release tag override', matched: true, release: true, overrides: true },
    { name: 'release tag at a different checkout revision', release: true, differentRevision: true },
    { name: 'release tag in a nested checkout with matching revision', release: true, nested: true },
    { name: 'attached checkout branch in a release pipeline', release: true, attached: true },
    { name: 'Azure PR merge checkout', azure: true, matched: true },
    { name: 'Azure PR source checkout', azure: true, matched: true, sourceCheckout: true },
    { name: 'Azure unrelated revision', azure: true, differentRevision: true },
    { name: 'Azure nested checkout matching the provider merge', azure: true, nested: true },
    { name: 'Azure attached checkout branch', azure: true, attached: true },
    { name: 'Azure PR without merge-ref evidence', azure: true, noMergeRef: true },
    { name: 'Azure missing workspace', azure: true, missingWorkspace: true },
    { name: 'Azure explicit overrides', azure: true, matched: true, overrides: true },
    { name: 'Azure workspace symlink', azure: true, matched: true, symlink: true },
  ]) {
    it(`scopes detached CI identity to the matching checkout: ${scenario.name}`, () => {
      const checkout = scenario.nested ? nested : root
      let azureSourceSha, azureMergeSha
      if (scenario.azure) {
        const base = git(checkout, ['rev-parse', 'HEAD'])
        git(checkout, ['fast-import', '--quiet'],
          'commit refs/heads/juan-fernandez/source\nmark :1\n' +
          'committer Test <test@example.com> 1700000001 +0000\ndata 6\nsource\n' +
          `from ${base}\nM 100644 inline source.txt\ndata 6\nsource\n\n` +
          'commit refs/heads/juan-fernandez/merge\n' +
          'committer Test <test@example.com> 1700000002 +0000\ndata 5\nmerge\n' +
          `from ${base}\nmerge :1\nM 100644 inline source.txt\ndata 6\nsource\n\n`)
        azureSourceSha = git(checkout, ['rev-parse', 'refs/heads/juan-fernandez/source'])
        azureMergeSha = git(checkout, ['rev-parse', 'refs/heads/juan-fernandez/merge'])
        assert.notStrictEqual(azureSourceSha, azureMergeSha)
        assert.deepStrictEqual(git(checkout, ['rev-parse', `${azureMergeSha}^`, `${azureMergeSha}^2`]).split('\n'),
          [base, azureSourceSha])
        git(checkout, ['reset', '--hard', scenario.differentRevision
          ? base
          : scenario.sourceCheckout ? azureSourceSha : azureMergeSha])
      }
      const sha = git(checkout, ['rev-parse', 'HEAD'])
      const mirror = 'http://mirror.example.test:8080/customer.git'
      const repository = scenario.azure
        ? 'https://dev.azure.com/example/project/_git/customer'
        : scenario.github ? 'https://github.com/example/customer.git' : 'https://example.com/customer.git'
      let workspace = root
      if (scenario.symlink) {
        workspace = path.join(directory, 'alias')
        fs.symlinkSync(root, workspace, 'junction')
      }
      if (!scenario.attached) git(checkout, ['checkout', '--quiet', '--detach', sha])
      if (scenario.tagged) git(checkout, ['update-ref', 'refs/tags/v1.0.0', sha])
      if (scenario.ambiguousTags) {
        git(checkout, ['update-ref', 'refs/tags/v1.0.0', sha])
        git(checkout, ['update-ref', 'refs/tags/v1.1.0', sha])
      }
      git(checkout, ['config', 'remote.origin.url', mirror])
      process.chdir(checkout)
      const ciTag = scenario.release ? 'release-v2' : undefined
      const ciBranch = ciTag || 'ci-branch'
      const ci = ciFor(scenario.azure
        ? {
            TF_BUILD: 'true',
            BUILD_REASON: 'PullRequest',
            BUILD_SOURCEVERSION: azureMergeSha,
            BUILD_SOURCEBRANCH: scenario.noMergeRef ? 'refs/heads/main' : 'refs/pull/123/merge',
            SYSTEM_PULLREQUEST_SOURCECOMMITID: azureSourceSha,
            SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/ci-branch',
            BUILD_REPOSITORY_URI: repository,
            BUILD_SOURCESDIRECTORY: scenario.missingWorkspace ? undefined : workspace,
          }
        : scenario.github
          ? {
              GITHUB_ACTIONS: 'true',
              GITHUB_SHA: sha,
              GITHUB_REF: ciTag ? `refs/tags/${ciTag}` : 'refs/heads/ci-branch',
              GITHUB_REPOSITORY: 'example/customer',
              GITHUB_SERVER_URL: 'https://github.com',
              GITHUB_WORKSPACE: workspace,
            }
          : {
              GITLAB_CI: 'true',
              CI_COMMIT_SHA: scenario.missingRevision ? undefined : scenario.differentRevision ? providerSha : sha,
              CI_COMMIT_REF_NAME: scenario.missingBranch ? undefined : ciBranch,
              CI_COMMIT_TAG: ciTag,
              CI_REPOSITORY_URL: scenario.missingRepository ? undefined : repository,
              CI_PROJECT_DIR: scenario.missingWorkspace ? undefined : workspace,
              CI_COMMIT_MESSAGE: 'provider message',
            })
      const overrides = scenario.overrides
        ? {
            'git.branch': 'user-branch',
            'git.repository_url': 'https://example.com/user.git',
            'git.tag': 'user-tag',
          }
        : {}
      if (scenario.azure) {
        const provider = ci.getCIMetadata()
        assert.strictEqual(provider['git.commit.sha'], azureSourceSha)
        assert.strictEqual(provider['ci.git.merge_commit_sha'], scenario.noMergeRef ? undefined : azureMergeSha)
      }
      const { getTestEnvironmentMetadata, getTestLevelsMetadataTags } =
        proxyquire('../../../src/plugins/util/test', {
          './ci': ci,
          './user-provided-git': { getUserProviderGitMetadata: () => overrides },
        })
      const metadata = getTestEnvironmentMetadata('mocha')
      const branch = scenario.overrides
        ? 'user-branch'
        : scenario.attached
          ? 'juan-fernandez/test'
          : scenario.matched && !scenario.missingBranch && !(scenario.github && scenario.release) ? ciBranch : undefined
      const repositoryUrl = scenario.overrides
        ? overrides['git.repository_url']
        : scenario.matched && !scenario.missingRepository ? repository : mirror
      const tag = scenario.overrides
        ? 'user-tag'
        : scenario.matched && scenario.release ? ciTag : scenario.tagged ? 'v1.0.0' : undefined
      for (const tags of [metadata, getTestLevelsMetadataTags(metadata)]) {
        assert.strictEqual(tags['git.branch'], branch)
        assert.strictEqual(tags['git.tag'], tag)
        assert.strictEqual(tags['git.repository_url'], repositoryUrl)
        assert.strictEqual(tags['git.commit.sha'], sha)
        assert.strictEqual(tags['git.checkout.root'], scenario.nested ? gitNested : gitRoot)
        if (scenario.azure) {
          assert.strictEqual(tags['ci.git.merge_commit_sha'], scenario.noMergeRef ? undefined : azureMergeSha)
        }
      }
      const commitMessage = scenario.azure && !scenario.differentRevision
        ? scenario.sourceCheckout ? 'source' : 'merge'
        : scenario.nested ? 'inner' : 'outer'
      assert.strictEqual(metadata['git.commit.message'].trim(), commitMessage)
      assert.strictEqual(metadata['git.checkout.is_custom'], scenario.nested ? 'true' : undefined)
      assert.strictEqual(gitUtils.getRepositoryUrl(checkout), mirror)
    })
  }

  it('keeps history discovery and packed objects in the selected checkout after cwd changes', () => {
    process.chdir(nested)
    const metadata = gitUtils.getGitMetadata({ ciWorkspacePath: root })
    const selectedSha = metadata['git.commit.sha']
    git(nested, ['config', 'remote.origin.url', 'https://example.com/tools.git'])
    process.chdir(root)

    assert.strictEqual(gitUtils.getRepositoryUrl(nested), 'https://example.com/tools.git')
    const commits = gitUtils.getLatestCommits(selectedSha, nested)
    assert.deepStrictEqual(commits, [selectedSha])
    const objects = gitUtils.getCommitsRevList([], commits, false, nested)
    const packs = gitUtils.generatePackFilesForCommits(objects, nested)
    assert.strictEqual(packs.length, 1)
    try {
      const contents = git(nested, ['verify-pack', '-v', packs[0].replace(/\.pack$/, '.idx')])
      assert.match(contents, new RegExp(`^${selectedSha} commit `, 'm'))
      assert.doesNotMatch(contents, new RegExp(`^${git(root, ['rev-parse', 'HEAD'])} commit `, 'm'))
    } finally {
      for (const pack of packs) {
        fs.rmSync(pack, { force: true })
        fs.rmSync(pack.replace(/\.pack$/, '.idx'), { force: true })
      }
    }
  })

  it('uploads the selected checkout packfile when cwd changes during the search request', async () => {
    process.chdir(nested)
    const selectedSha = git(nested, ['rev-parse', 'HEAD'])
    const generated = []
    /** @type {{uploaded?: Buffer, searched?: {data: {id: string, type: string}[]}, boundary?: string}} */
    const captured = {}
    const uploader = proxyquire('../../../src/ci-visibility/exporters/git/git_metadata', {
      '../../../config': () => ({ testOptimization: { DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED: false } }),
      '../../../plugins/util/git': {
        ...gitUtils,
        /**
         * @param {string[]} commits
         * @param {string=} cwd
         */
        generatePackFilesForCommits (commits, cwd) {
          const files = gitUtils.generatePackFilesForCommits(commits, cwd)
          generated.push(...files)
          return files
        },
      },
      '../../../exporters/common/request': (payload, options, callback) => {
        if (options.path.endsWith('/search_commits')) {
          captured.searched = JSON.parse(payload)
          process.chdir(root)
          setImmediate(() => callback(null, '{"data":[]}', 200))
        } else {
          captured.boundary = options.headers['Content-Type'].split('boundary=')[1]
          ;(async () => {
            const chunks = []
            for await (const chunk of payload) chunks.push(chunk)
            captured.uploaded = Buffer.concat(chunks)
          })().then(() => callback(null, '', 204), callback)
        }
      },
    })
    try {
      await new Promise((resolve, reject) => {
        uploader.sendGitMetadata(new URL('https://example.com'), { isEvpProxy: false }, undefined,
          err => err ? reject(err) : resolve(undefined), selectedSha, nested)
      })
      const { searched, uploaded, boundary } = captured
      assert.ok(searched)
      assert.ok(uploaded)
      assert.deepStrictEqual(searched.data, [{ id: selectedSha, type: 'commit' }])
      assert.match(uploaded.toString(), new RegExp(`"id":"${selectedSha}"`))
      const pack = path.join(directory, 'uploaded.pack')
      fs.writeFileSync(pack, uploaded.subarray(uploaded.indexOf('PACK'), uploaded.lastIndexOf(`\r\n--${boundary}`)))
      git(nested, ['index-pack', pack])
      const contents = git(nested, ['verify-pack', '-v', pack.replace(/\.pack$/, '.idx')])
      assert.match(contents, new RegExp(`^${selectedSha} commit `, 'm'))
      assert.doesNotMatch(contents, new RegExp(`^${git(root, ['rev-parse', 'HEAD'])} commit `, 'm'))
    } finally {
      for (const pack of generated) {
        fs.rmSync(pack, { force: true })
        fs.rmSync(pack.replace(/\.pack$/, '.idx'), { force: true })
      }
    }
  })

  for (const consumer of ['shared plugin', 'Cypress']) {
    for (const scenario of [
      { name: 'workflow PR', custom: false, files: ['provider-test.js'] },
      { name: 'selected checkout', custom: true, files: ['checkout-test.js'] },
      { name: 'foreign workflow PR', custom: true, foreign: true, files: ['checkout-test.js'] },
      {
        name: 'explicit PR head',
        custom: true,
        overrides: { 'git.commit.head.sha': 'explicit' },
        files: ['explicit-test.js'],
      },
      {
        name: 'explicit base SHA',
        custom: true,
        overrides: { 'git.pull_request.base_branch_sha': 'provider' },
        files: ['checkout-test.js', 'provider-test.js'],
      },
      {
        name: 'explicit remote base branch',
        custom: true,
        foreign: true,
        overrides: { 'git.pull_request.base_branch': 'customer-base' },
        files: ['checkout-test.js'],
      },
      {
        name: 'explicit local base branch',
        custom: true,
        foreign: true,
        overrides: { 'git.pull_request.base_branch': 'customer-local' },
        files: ['checkout-test.js'],
      },
      {
        name: 'unrelated explicit local base branch',
        custom: true,
        foreign: true,
        overrides: { 'git.pull_request.base_branch': 'customer-unrelated' },
        files: [],
        failure: true,
      },
      {
        name: 'explicit base and PR head',
        custom: true,
        overrides: { 'git.pull_request.base_branch_sha': 'provider', 'git.commit.head.sha': 'explicit' },
        files: ['explicit-test.js', 'provider-test.js'],
      },
      {
        name: 'explicit checkout SHA',
        custom: true,
        overrides: { 'git.commit.sha': 'explicit' },
        files: ['explicit-test.js'],
      },
    ]) {
      it(`selects impacted-test diff revisions for ${scenario.name} (${consumer})`, async () => {
        const base = git(nested, ['rev-parse', 'HEAD'])
        /** @type {Record<string, string>} */
        const revisions = {}
        for (const [revision, file] of [
          ['provider', 'provider-test.js'], ['checkout', 'checkout-test.js'], ['explicit', 'explicit-test.js'],
        ]) {
          git(nested, ['fast-import', '--quiet'],
            `commit refs/heads/juan-fernandez/${revision}\n` +
            'committer Test <test@example.com> 1700000001 +0000\n' +
            `data ${revision.length}\n${revision}\nfrom ${base}\n` +
            `M 100644 inline ${file}\ndata ${revision.length}\n${revision}\n\n`)
          revisions[revision] = git(nested, ['rev-parse', `refs/heads/juan-fernandez/${revision}`])
        }
        let checkout = revisions.checkout
        if (!scenario.custom) {
          git(nested, ['fast-import', '--quiet'],
            'commit refs/heads/juan-fernandez/merge\n' +
            'committer Test <test@example.com> 1700000002 +0000\ndata 5\nmerge\n' +
            `from ${revisions.provider}\nmerge ${revisions.checkout}\n` +
            'M 100644 inline checkout-test.js\ndata 8\ncheckout\n\n')
          checkout = git(nested, ['rev-parse', 'refs/heads/juan-fernandez/merge'])
        }
        git(nested, ['reset', '--hard', checkout])
        // Every possible base is local; even a failing control can only fetch from this fixture.
        git(nested, ['config', 'remote.origin.url', nested])
        for (const branch of ['main', 'master', 'preprod', 'prod', 'dev', 'development', 'trunk']) {
          git(nested, ['update-ref', `refs/remotes/origin/${branch}`, base])
        }
        git(nested, ['update-ref', 'refs/remotes/origin/customer-base', revisions.provider])
        git(nested, ['update-ref', 'refs/heads/customer-local', revisions.provider])
        git(nested, ['update-ref', 'refs/remotes/origin/customer-local', revisions.checkout])
        git(nested, ['fast-import', '--quiet'],
          'commit refs/heads/customer-unrelated\n' +
          'committer Test <test@example.com> 1700000003 +0000\ndata 9\nunrelated\n' +
          'M 100644 inline unrelated-test.js\ndata 9\nunrelated\n\n')
        git(nested, ['update-ref', 'refs/remotes/origin/customer-unrelated', base])
        process.chdir(nested)

        const overrides = Object.fromEntries(Object.entries(scenario.overrides || {})
          .map(([key, value]) => [key, revisions[value] || value]))
        const metadata = {
          'git.checkout.root': gitNested,
          'git.checkout.is_custom': scenario.custom ? 'true' : undefined,
          'ci.workspace_path': scenario.custom ? gitRoot : gitNested,
          'git.commit.sha': checkout,
          'git.commit.head.sha': scenario.foreign ? 'd'.repeat(40) : revisions.provider,
          'git.pull_request.base_branch_sha': scenario.foreign ? 'c'.repeat(40) : base,
          'git.pull_request.base_branch': 'workflow-main',
          ...overrides,
        }
        const originalMetadata = { ...metadata }
        const testStubs = { getTestEnvironmentMetadata: () => metadata, getCodeOwnersFileEntries: () => [] }
        const userStubs = { getUserProviderGitMetadata: () => overrides }
        let modifiedFiles
        if (consumer === 'shared plugin') {
          const CiPlugin = proxyquire('../../../src/plugins/ci_plugin', {
            './util/test': testStubs,
            './util/user-provided-git': userStubs,
          })
          class CheckoutPlugin extends CiPlugin {
            static id = 'vitest'
          }
          const plugin = new CheckoutPlugin({ _exporter: {} })
          plugin.configure({ enabled: true, tracing: { DD_TRACE_EXPERIMENTAL_EXPORTER: 'vitest_worker' } })
          const onDone = sinon.spy()
          try {
            dc.channel('ci:vitest:modified-files').publish({ onDone })
            sinon.assert.calledOnce(onDone)
            if (scenario.failure) {
              assert.match(onDone.firstCall.args[0].err.message, /No modified tests could have been retrieved/)
            } else {
              assert.strictEqual(onDone.firstCall.args[0].err, null)
            }
            modifiedFiles = onDone.firstCall.args[0].modifiedFiles
          } finally {
            plugin.configure(false)
          }
        } else {
          const stop = new Error('stop after modified-file discovery')
          const plugin = proxyquire('../../../../datadog-plugin-cypress/src/cypress-plugin', {
            '../../dd-trace/src/plugins/util/test': {
              ...testStubs, getTestParentSpan: () => { throw stop },
            },
            '../../dd-trace/src/plugins/util/user-provided-git': userStubs,
          })
          plugin._isInit = true
          plugin.isImpactedTestsEnabled = true
          await assert.rejects(plugin.beforeRun({}), error => error === stop)
          modifiedFiles = plugin.modifiedFiles
          if (scenario.failure) assert.strictEqual(plugin.isImpactedTestsEnabled, false)
        }
        assert.deepStrictEqual(Object.keys(modifiedFiles || {}).sort(), scenario.files)
        assert.deepStrictEqual(metadata, originalMetadata)
      })
    }
  }

  it('does not share cached command results between independent checkouts', () => {
    const { cachedExec } = proxyquire('../../../src/plugins/util/git-cache', {
      '../../config': () => ({
        DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED: true,
        DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR: path.join(directory, 'cache'),
      }),
    })
    const rootSha = cachedExec('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
    const nestedSha = cachedExec('git', ['rev-parse', 'HEAD'], { cwd: nested }).toString().trim()
    assert.strictEqual(rootSha, git(root, ['rev-parse', 'HEAD']))
    assert.strictEqual(nestedSha, git(nested, ['rev-parse', 'HEAD']))
    assert.notStrictEqual(rootSha, nestedSha)
  })

  for (const destination of ['refs/heads/upstream-main', 'refs/remotes/origin/main']) {
    for (const remote of ['upstream', '.']) {
      it(`resolves the current branch remote with a custom destination ${destination} (remote=${remote})`, () => {
        git(root, ['remote', 'add', 'upstream', 'https://example.com/upstream.git'])
        git(root, ['config', 'remote.upstream.fetch', `+refs/heads/main:${destination}`])
        git(root, ['update-ref', destination, 'HEAD'])
        git(root, ['config', 'branch.juan-fernandez/test.remote', remote])
        git(root, ['config', 'branch.juan-fernandez/test.merge', remote === '.' ? destination : 'refs/heads/main'])
        git(root, ['config', 'branch.other.remote', 'origin'])

        assert.strictEqual(gitUtils.getGitRemoteName(root), remote === '.' ? 'origin' : remote)
      })
    }
  }

  it('uses the current branch configuration when a tag has the same name', () => {
    git(root, ['remote', 'add', 'upstream', 'https://example.com/upstream.git'])
    git(root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'])
    git(root, ['update-ref', 'refs/tags/juan-fernandez/test', 'HEAD'])
    git(root, ['config', 'branch.juan-fernandez/test.remote', 'upstream'])
    git(root, ['config', 'branch.juan-fernandez/test.merge', 'refs/heads/main'])
    git(root, ['config', 'branch.other.remote', 'origin'])

    assert.strictEqual(gitUtils.getGitRemoteName(root), 'upstream')
  })

  it('preserves checkout and provider merge identities on every encoded test level', () => {
    process.chdir(nested)
    const { getTestEnvironmentMetadata, getTestLevelsMetadataTags } = proxyquire('../../../src/plugins/util/test', {
      './ci': ciFor({
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: providerSha,
        GITHUB_REF: 'refs/pull/123/merge',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_WORKSPACE: root,
      }),
      './user-provided-git': { getUserProviderGitMetadata: () => ({}) },
    })
    const metadata = getTestEnvironmentMetadata('mocha')
    const expected = {
      'git.checkout.root': gitNested,
      'git.checkout.is_custom': 'true',
      'ci.workspace_path': root,
      'ci.git.merge_commit_sha': providerSha,
      'git.commit.sha': git(nested, ['rev-parse', 'HEAD']),
    }
    const testLevels = getTestLevelsMetadataTags(metadata)
    for (const [key, value] of Object.entries(expected)) assert.strictEqual(testLevels[key], value, key)

    const encoder = new AgentlessCiVisibilityEncoder({ flush () {} }, { tags: {} })
    encoder.addMetadataTags({ test_levels: testLevels })
    const eventTypes = ['test_session_end', 'test_module_end', 'test_suite_end', 'test']
    for (const type of eventTypes) {
      encoder.encode([{
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('0'),
        type,
        name: 'mocha.test',
        resource: 'example',
        service: 'example',
        error: 0,
        start: 0,
        duration: 1,
        meta: {},
        metrics: {},
      }])
    }
    const payload = /** @type {EncodedTestPayload} */ (msgpack.decode(encoder.makePayload(), { useBigInt64: true }))
    assert.deepStrictEqual(payload.events.map(event => event.type), eventTypes)
    for (const event of payload.events) {
      const tags = { ...payload.metadata.test_levels, ...event.content.meta }
      for (const [key, value] of Object.entries(expected)) assert.strictEqual(tags[key], value, `${event.type}: ${key}`)
    }
  })
})
