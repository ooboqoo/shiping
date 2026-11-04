const path = require('node:path')
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'library-maintenance.ts')],
  outfile: path.join(__dirname, '../out/tools/library-maintenance.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22'
})
