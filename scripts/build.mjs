import { build, context } from 'esbuild';
import process from 'node:process';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // vscode 由宿主在运行时注入，必须外部化
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info'
};

try {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
