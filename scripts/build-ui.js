#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Building UI package...');

try {
  const rootDir = path.join(__dirname, '..');
  const uiDir = path.join(rootDir, 'packages/ui');
  const cliDistDir = path.join(rootDir, 'packages/cli/dist');
  const coreDistDir = path.join(rootDir, 'packages/core/dist');
  const rootDistDir = path.join(rootDir, 'dist');

  // Step 1: Build the UI (vite single-file bundle -> packages/ui/dist/index.html)
  console.log('Building UI application...');
  execSync('pnpm build', {
    stdio: 'inherit',
    cwd: uiDir
  });

  // Step 2: Propagate the freshly built index.html to any already-built CLI/root
  // dist so a locally-running `ccr` (served from packages/cli/dist) picks it up
  // after a standalone `build:ui`, without needing a full `build:cli`.
  //
  // Only overwrite when the target dist already exists — build:cli owns the
  // lifecycle of those directories (it recreates cli/dist from scratch), so we
  // never create partial dist trees here.
  const uiSource = path.join(uiDir, 'dist/index.html');
  if (fs.existsSync(uiSource)) {
    for (const distDir of [cliDistDir, coreDistDir, rootDistDir]) {
      if (!fs.existsSync(distDir)) {
        continue;
      }
      const dest = path.join(distDir, 'index.html');
      fs.copyFileSync(uiSource, dest);
      console.log(`✓ index.html synced to ${path.relative(rootDir, dest)}`);
    }
  } else {
    console.warn('⚠ Warning: index.html not found in UI dist, skipping sync...');
  }

  console.log('\nUI build completed successfully!');
} catch (error) {
  console.error('UI build failed:', error.message);
  process.exit(1);
}
