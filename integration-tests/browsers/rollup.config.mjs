import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'

export default {
    input: './bundle-entrypoint.js',
    plugins: [
        commonjs(),
        nodeResolve()
    ],
    output: {
        name: 'dd-trace',
        file: 'out/rollup.js',
        format: 'umd'
    }
}
