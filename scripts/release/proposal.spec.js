'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_FULL_SHA = '89abcdef0123456789abcdef0123456789abcdef'
const VERSION_FULL_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

describe('release proposal', () => {
  it('preserves empty commits while applying new changes', () => {
    const stopped = new Error('proposal stopped after applying changes')
    const createReleaseChangelog = sinon.stub().returns({
      isMinor: true,
      markdown: '',
      warnings: [],
    })
    const fail = sinon.stub()
    const run = sinon.stub().callsFake(command => {
      if (command.startsWith('npm version')) throw stopped
    })

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v5.x master')) return FULL_SHA
      if (command === `git rev-parse ${FULL_SHA}`) return FULL_SHA
      if (command.includes('--format=sha --reverse v5.x') && command.includes(FULL_SHA)) return FULL_SHA
      if (command === `git show -s --format=%s ${FULL_SHA}`) return 'chore(deps-dev): bump multer (#10253)'
      if (command === 'git log -1 --pretty=%B') return 'v5.127.0'
      if (command.startsWith('git log --format="%H%x09%s"')) return `${VERSION_FULL_SHA}\tv5.127.0`
      if (command.includes(`v5.127.0-proposal ${FULL_SHA}`)) return 'chore(deps-dev): bump multer'
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadProposal = proxyquire.noCallThru().noPreserveCache()
    loadProposal('./proposal', {
      '../../version': { DD_MAJOR: 5, DD_MINOR: 126, DD_PATCH: 0, VERSION: '5.126.0' },
      './changelog': { createReleaseChangelog },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        checkpoint: sinon.stub(),
        fail,
        fatal: sinon.stub(),
        flags: {},
        log: sinon.stub(),
        params: ['5'],
        pass: sinon.stub(),
        run,
        start: sinon.stub(),
      },
      './metadata': { hydrateReleaseEntries: sinon.stub().returnsArg(0) },
    })

    assert(run.calledWithExactly(`git cherry-pick --allow-empty ${FULL_SHA}`))
    assert.strictEqual(fail.firstCall.args[0], stopped)
  })

  it('reports both sides when proposal history does not match master', () => {
    const stopped = new Error('proposal stopped after detecting divergence')
    const createReleaseChangelog = sinon.stub().returns({
      isMinor: true,
      markdown: '',
      warnings: [],
    })
    const fail = sinon.stub()
    const fatal = sinon.stub().throws(stopped)
    const run = sinon.stub()
    const masterSubject = 'fix(core): expected change (#123)'
    const proposalSubject = 'fix(core): unexpected change (#999)'

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v5.x master')) return FULL_SHA
      if (command === `git rev-parse ${FULL_SHA}`) return FULL_SHA
      if (command.includes('--format=sha --reverse v5.x') && command.includes(FULL_SHA)) return FULL_SHA
      if (command === `git show -s --format=%s ${FULL_SHA}`) return masterSubject
      if (command === 'git log -1 --pretty=%B') return 'v5.127.0'
      if (command.startsWith('git log --format="%H%x09%s"')) {
        return `${OTHER_FULL_SHA}\t${proposalSubject}\n${VERSION_FULL_SHA}\tv5.127.0`
      }
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadProposal = proxyquire.noCallThru().noPreserveCache()
    loadProposal('./proposal', {
      '../../version': { DD_MAJOR: 5, DD_MINOR: 126, DD_PATCH: 0, VERSION: '5.126.0' },
      './changelog': { createReleaseChangelog },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        checkpoint: sinon.stub(),
        fail,
        fatal,
        flags: {},
        log: sinon.stub(),
        params: ['5'],
        pass: sinon.stub(),
        run,
        start: sinon.stub(),
      },
      './metadata': { hydrateReleaseEntries: sinon.stub().returnsArg(0) },
    })

    assert(fatal.calledWithExactly(
      'Release proposal history diverged from master at position 1.',
      `  proposal: ${OTHER_FULL_SHA.slice(0, 10)} ${proposalSubject}`,
      `  master: ${FULL_SHA.slice(0, 10)} ${masterSubject}`
    ))
    assert.strictEqual(fail.firstCall.args[0], stopped)
  })

  it('reports the incoming commit, proposal state, and conflicted files', () => {
    const stopped = new Error('proposal stopped after cherry-pick failure')
    const cherryPickError = new Error('cherry-pick failed')
    cherryPickError.stderr = 'CONFLICT (content): merge conflict in package.json\n'
    const createReleaseChangelog = sinon.stub().returns({
      isMinor: true,
      markdown: '',
      warnings: [],
    })
    const fail = sinon.stub()
    const fatal = sinon.stub().throws(stopped)
    const run = sinon.stub().callsFake(command => {
      if (command.startsWith('git cherry-pick --allow-empty')) throw cherryPickError
    })

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v5.x master')) return FULL_SHA
      if (command === `git rev-parse ${FULL_SHA}`) return FULL_SHA
      if (command.includes('--format=sha --reverse v5.x') && command.includes(FULL_SHA)) return FULL_SHA
      if (command === `git show -s --format=%s ${FULL_SHA}`) return 'fix(core): incoming change (#123)'
      if (command === 'git log -1 --pretty=%B') return 'v5.127.0'
      if (command.startsWith('git log --format="%H%x09%s"')) return `${VERSION_FULL_SHA}\tv5.127.0`
      if (command.includes(`v5.127.0-proposal ${FULL_SHA}`)) return 'fix(core): incoming change'
      if (command.includes('CHERRY_PICK_HEAD')) return '0123456789 fix(core): incoming change (#123)'
      if (command === 'git show -s --format="%h %s" HEAD') return '89abcdef01 v5.126.0'
      if (command === 'git diff --name-only --diff-filter=U') return 'package.json\nyarn.lock'
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadProposal = proxyquire.noCallThru().noPreserveCache()
    loadProposal('./proposal', {
      '../../version': { DD_MAJOR: 5, DD_MINOR: 126, DD_PATCH: 0, VERSION: '5.126.0' },
      './changelog': { createReleaseChangelog },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        checkpoint: sinon.stub(),
        fail,
        fatal,
        flags: {},
        log: sinon.stub(),
        params: ['5'],
        pass: sinon.stub(),
        run,
        start: sinon.stub(),
      },
      './metadata': { hydrateReleaseEntries: sinon.stub().returnsArg(0) },
    })

    assert(run.calledWithExactly('git cherry-pick --abort'))
    assert(fatal.calledWithExactly(
      'Cherry-pick failed. This means that the release branch has deviated from the main branch.',
      'Please make sure the release branch contains all changes from the main branch.',
      'Incoming from master: 0123456789 fix(core): incoming change (#123)',
      'Applying onto v5.127.0-proposal: 89abcdef01 v5.126.0',
      'Conflicted files: package.json, yarn.lock',
      'CONFLICT (content): merge conflict in package.json'
    ))
    assert.strictEqual(fail.firstCall.args[0], stopped)
  })

  it('describes commit and pull request metadata sources before rendering the changelog', () => {
    const stopped = new Error('proposal stopped after changelog creation')
    const createReleaseChangelog = sinon.stub().throws(stopped)
    const fail = sinon.stub()
    const hydrateReleaseEntries = sinon.stub().returnsArg(0)

    /**
     * @param {string} command
     */
    function capture (command) {
      if (command === 'git rev-parse --abbrev-ref HEAD') return 'master'
      if (command.includes('--format=sha --reverse v7.x master')) return '0123456789\n89abcdef01'
      if (command === 'git rev-parse 89abcdef01') return OTHER_FULL_SHA
      if (command.includes('--format=sha --reverse v7.x') && command.includes(OTHER_FULL_SHA)) {
        return '0123456789\n89abcdef01'
      }
      if (command === 'git show -s --format=%s 0123456789') return 'fix(core): preserve context (#123)'
      if (command === 'git show -s --format=%s 89abcdef01') return 'docs: update release notes'
      if (command === 'git log -1 --format=%cs v6.0.0') return '2026-01-01'
      if (command === `git show -s --format=%cs ${OTHER_FULL_SHA}`) return '2026-08-01'
      if (command.startsWith('git log --format=%s v6.0.0..')) {
        return 'feat(core)!: remove legacy context (#456)\nfix(core)!: replace context storage (#457)'
      }
      if (command.includes('--label=semver-major')) {
        return JSON.stringify([
          {
            number: 456,
            title: 'feat(core)!: remove legacy context',
            mergeCommit: undefined,
          },
          {
            number: 457,
            title: 'fix(core)!: replace context storage',
            mergeCommit: { oid: FULL_SHA },
          },
        ])
      }
      if (command.includes('--label=only-land-on-next')) return '[]'
      throw new Error(`Unexpected command: ${command}`)
    }

    const loadProposal = proxyquire.noCallThru().noPreserveCache()
    loadProposal('./proposal', {
      '../../version': { DD_MAJOR: 7, DD_MINOR: 0, DD_PATCH: 0, VERSION: '7.0.0-beta.1' },
      './changelog': { createReleaseChangelog },
      './helpers/requirements': { checkAll: sinon.stub() },
      './helpers/terminal': {
        capture,
        checkpoint: sinon.stub(),
        fail,
        fatal: sinon.stub(),
        flags: {},
        log: sinon.stub(),
        params: ['7'],
        pass: sinon.stub(),
        run: sinon.stub(),
        start: sinon.stub(),
      },
      './metadata': { hydrateReleaseEntries },
    })

    assert.strictEqual(fail.firstCall.args[0], stopped)
    assert.deepStrictEqual(hydrateReleaseEntries.firstCall.args[0], [
      {
        commitRef: '0123456789',
        pullRequestNumber: 123,
        subject: 'fix(core): preserve context (#123)',
      },
      {
        commitRef: '89abcdef01',
        pullRequestNumber: undefined,
        subject: 'docs: update release notes',
      },
    ])
    assert.deepStrictEqual(hydrateReleaseEntries.secondCall.args[0], [
      {
        commitRef: undefined,
        pullRequestNumber: 456,
        subject: 'feat(core)!: remove legacy context (#456)',
      },
      {
        commitRef: FULL_SHA,
        pullRequestNumber: 457,
        subject: 'fix(core)!: replace context storage (#457)',
      },
    ])
    assert.strictEqual(createReleaseChangelog.firstCall.args[0], hydrateReleaseEntries.firstCall.returnValue)
    assert.strictEqual(createReleaseChangelog.firstCall.args[1], hydrateReleaseEntries.secondCall.returnValue)
  })
})
