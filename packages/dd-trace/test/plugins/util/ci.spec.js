const { getCIMetadata } = require('../../../src/plugins/util/ci')
const jenkinsEnv = require('./ci-env/jenkins.json')
const gitlabEnv = require('./ci-env/gitlab.json')
const circleciEnv = require('./ci-env/circleci.json')
const githubEnv = require('./ci-env/github.json')

describe('ci tags', () => {
  it('returns an empty object if the CI is not supported', () => {
    process.env = {}
    expect(getCIMetadata()).to.eql({})
  })
  describe('jenkins', () => {
    jenkinsEnv.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info from jenkins ${index}`, () => {
        process.env = env
        expect(getCIMetadata()).to.eql(expectedSpanTags)
      })
    })
  })
  describe('gitlab', () => {
    gitlabEnv.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info from gitlab ${index}`, () => {
        process.env = env
        expect(getCIMetadata()).to.eql(expectedSpanTags)
      })
    })
  })
  describe('circleci', () => {
    circleciEnv.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info from circleci ${index}`, () => {
        process.env = env
        expect(getCIMetadata()).to.eql(expectedSpanTags)
      })
    })
  })
  describe('githubEnv', () => {
    githubEnv.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info from github ${index}`, () => {
        process.env = env
        expect(getCIMetadata()).to.eql(expectedSpanTags)
      })
    })
  })
})
