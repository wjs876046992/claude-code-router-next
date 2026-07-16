#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Building Server compatibility facade...');

try {
  const rootDir = path.join(__dirname, '..');
  const serverDir = path.join(rootDir, 'packages/server');
  const coreDir = path.join(rootDir, 'packages/core');

  // The facade imports @wengine-ai/llms; ensure the core artifacts/types exist.
  if (!fs.existsSync(path.join(coreDir, 'dist/server.d.ts'))) {
    console.log('Core package not built, building it first...');
    execSync('pnpm --filter @wengine-ai/llms build', {
      stdio: 'inherit',
      cwd: rootDir,
    });
  }

  const distDir = path.join(serverDir, 'dist');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  console.log('Generating facade declarations...');
  execSync('pnpm exec tsc --emitDeclarationOnly', {
    stdio: 'inherit',
    cwd: serverDir,
  });

  console.log('Bundling facade entry...');
  execSync('pnpm exec esbuild src/index.ts --bundle --platform=node --format=cjs --external:@wengine-ai/llms --outfile=dist/index.js', {
    stdio: 'inherit',
    cwd: serverDir,
  });

  // No runtime assets (WASM/UI) are copied here: the server package is a facade.
  console.log('Server facade build completed successfully!');
} catch (error) {
  console.error('Server facade build failed:', error.message);
  process.exit(1);
}
