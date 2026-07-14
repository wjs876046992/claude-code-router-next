#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Building CLI package...');

try {
  const rootDir = path.join(__dirname, '..');
  const sharedDir = path.join(rootDir, 'packages/shared');
  const coreDir = path.join(rootDir, 'packages/core');
  const cliDir = path.join(rootDir, 'packages/cli');
  const uiDir = path.join(rootDir, 'packages/ui');

  // Step 0: build shared and core first. CLI imports the CCR runtime directly
  // from @wengine-ai/llms and no longer depends on the server facade.
  console.log('Building Shared package...');
  execSync('node scripts/build-shared.js', {
    stdio: 'inherit',
    cwd: rootDir,
  });

  console.log('Building Core package...');
  execSync('pnpm --filter @wengine-ai/llms build', {
    stdio: 'inherit',
    cwd: rootDir,
  });

  // Step 1: Build UI package
  console.log('Building UI package...');
  execSync('pnpm build', {
    stdio: 'inherit',
    cwd: uiDir,
  });

  // Step 2: Recreate CLI dist directory to avoid publishing stale artifacts.
  const cliDistDir = path.join(cliDir, 'dist');
  if (fs.existsSync(cliDistDir)) {
    fs.rmSync(cliDistDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cliDistDir, { recursive: true });

  // Step 3: Build the CLI application. Bundle the core CommonJS entry so the
  // final CommonJS CLI never re-bundles the core ESM entry or its import.meta
  // bootstrap (which would make createRequire receive an undefined URL).
  console.log('Building CLI application...');
  execSync('pnpm exec esbuild src/cli.ts --bundle --platform=node --format=cjs --minify --tree-shaking=true --external:lru-cache --external:better-sqlite3 --alias:@wengine-ai/llms=../core/dist/cjs/server.cjs --outfile=dist/cli.js', {
    stdio: 'inherit',
    cwd: cliDir,
  });

  // Step 4: Copy tiktoken WASM file from core dist to CLI dist
  console.log('Copying tiktoken_bg.wasm from core to CLI dist...');
  const tiktokenSource = path.join(coreDir, 'dist/tiktoken_bg.wasm');
  const tiktokenDest = path.join(cliDistDir, 'tiktoken_bg.wasm');

  if (fs.existsSync(tiktokenSource)) {
    fs.copyFileSync(tiktokenSource, tiktokenDest);
    console.log('tiktoken_bg.wasm copied successfully!');
  } else {
    console.warn('Warning: tiktoken_bg.wasm not found in core dist, skipping...');
  }

  // Step 5: Copy UI index.html from UI dist to CLI dist
  console.log('Copying index.html from UI to CLI dist...');
  const uiSource = path.join(uiDir, 'dist/index.html');
  const uiDest = path.join(cliDistDir, 'index.html');

  if (fs.existsSync(uiSource)) {
    fs.copyFileSync(uiSource, uiDest);
    console.log('index.html copied successfully!');
  } else {
    console.warn('Warning: index.html not found in UI dist, skipping...');
  }

  // Step 6: Copy CLI dist to project root
  console.log('\nCopying CLI dist to project root...');
  const rootDistDir = path.join(rootDir, 'dist');

  if (fs.existsSync(rootDistDir)) {
    fs.rmSync(rootDistDir, { recursive: true, force: true });
  }

  fs.cpSync(cliDistDir, rootDistDir, { recursive: true });
  console.log('CLI dist copied to project root successfully!');

  console.log('\nCLI build completed successfully!');
  console.log('\nCLI dist contents:');
  const files = fs.readdirSync(cliDistDir);
  files.forEach(file => {
    const filePath = path.join(cliDistDir, file);
    const stats = fs.statSync(filePath);
    const size = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`  - ${file} (${size} MB)`);
  });
} catch (error) {
  console.error('CLI build failed:', error.message);
  process.exit(1);
}
