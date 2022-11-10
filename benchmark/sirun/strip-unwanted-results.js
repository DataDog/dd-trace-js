#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const IGNORE_TESTS = new Set([
    'profiler'
])

const IGNORE_STATS = [
    'system.time'
]

const lines = fs
    .readFileSync(path.join(__dirname, 'results.ndjson'))
    .toString()
    .trim()
    .split('\n')

const results = []

for (let line of lines) {
    obj = JSON.parse(line)

    if (IGNORE_TESTS.has(obj.name)) {
        console.error('SKIP', obj.name);
        continue
    }

    for (let iteration of obj.iterations) {
        for (let stat of IGNORE_STATS) {
            if (stat in iteration) {
                console.error('DELETE', obj.name, stat);
                delete iteration[stat]
            }
        }
    }
    results.push(JSON.stringify(obj))
}

fs.writeFileSync('./results-modified.ndjson', results.join('\n'))
