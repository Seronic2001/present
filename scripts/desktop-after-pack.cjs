// Node will not strip types from files under node_modules, and packaging turns the workspace links
// into copies there. So each @present package becomes a stub that points back at packages/.
const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async ({ appOutDir }) => {
  const app = join(appOutDir, 'resources', 'app');
  const scope = join(app, 'node_modules', '@present');
  rmSync(scope, { recursive: true, force: true });
  for (const name of readdirSync(join(app, 'packages'))) {
    const entry = join(app, 'packages', name, 'src', 'index.ts');
    if (!existsSync(entry)) continue;
    const dir = join(scope, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@present/${name}`, version: '0.0.0', type: 'module', exports: './index.mjs' }));
    writeFileSync(join(dir, 'index.mjs'), `export * from '../../../packages/${name}/src/index.ts';\n`);
  }
};
