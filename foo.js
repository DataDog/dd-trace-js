const { pushSignedCommits } = require('./scripts/release/helpers/git')

pushSignedCommits(process.env.GITHUB_TOKEN, 'DataDog/dd-trace-js', 'rochdev/signed-proposal-test', 'origin', 'master')
