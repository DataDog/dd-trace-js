const files = process.argv.slice(2).sort()

await Promise.all(files.map(file => import(new URL('../' + file, import.meta.url))))
