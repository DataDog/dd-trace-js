const entrypoint = import.meta.resolve('postgres')
await import(new URL('./query.js', entrypoint))
