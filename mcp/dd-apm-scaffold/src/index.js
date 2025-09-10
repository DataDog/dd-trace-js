'use strict'

const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const { scaffoldProject } = require('./scaffold')

yargs(hideBin(process.argv))
  .command('scaffold <report> <name>', 'Scaffold a new integration project', (yargs) => {
    return yargs
      .positional('report', {
        describe: 'Path to the analysis report JSON file',
        type: 'string'
      })
      .positional('name', {
        describe: 'Name of the integration (e.g., redis)',
        type: 'string'
      })
      .option('language', {
        alias: 'l',
        describe: 'Target language (default: nodejs)',
        type: 'string',
        default: 'nodejs'
      })
      .option('output', {
        alias: 'o',
        describe: 'Output directory for the project',
        type: 'string',
        default: './'
      })
  }, async (argv) => {
    try {
      const projectPath = await scaffoldProject(argv.report, argv.name, argv.language, argv.output)
      console.log(`Integration project scaffolded successfully at: ${projectPath}`)
    } catch (e) {
      console.error('An error occurred:', e.message)
      process.exit(1)
    }
  })
  .demandCommand(1)
  .parse()
