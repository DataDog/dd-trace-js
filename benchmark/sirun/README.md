# Benchmarks

This directory contains several different types of benchmarks.

These benchmarks rely on [sirun](https://github.com/DataDog/sirun/) for execution.

## Running Benchmarks Locally

First, install sirun:

```sh  
cargo install --git https://github.com/DataDog/sirun.git --branch main
```

Then, get into one of the directories alongside this file, and run the following:

```sh  
node ../run-all-variants.js
```

You can pipe this to `sirun --summarize` to get a summary of the resulting data. This can also be piped to the `means.js` script in this directory to view it in tabular form.

Putting that all together, the following will run benchmarks, summarize them, and give you nice tabular output.

```sh
node ../run-all-variants.js | sirun --summarize | node ../means.js
```
