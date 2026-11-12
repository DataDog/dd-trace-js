import { declareSuiteLocalTests } from '../vitest-suite-local-exclusions.mjs'
import { tracked } from './browser-exclusions-ledger.mjs'

declareSuiteLocalTests(tracked)
