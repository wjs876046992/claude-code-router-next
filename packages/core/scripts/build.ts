import * as esbuild from "esbuild";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import packageJson from "../package.json";
import { pathAliasPlugin } from "./esbuild-plugin-path-alias";

const watch = process.argv.includes("--watch");

// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = path.resolve(__dirname, "..");
const distDir = path.join(baseUrl, "dist");
const runtimeExternals = Object.keys(packageJson.dependencies || {});

const baseConfig: esbuild.BuildOptions = {
  entryPoints: ["src/server.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  plugins: [
    pathAliasPlugin({
      alias: {
        "@/*": "src/*",
      },
      baseUrl,
    }),
  ],
  // Keep runtime dependencies external. Besides reducing bundle size, this lets
  // both CJS and ESM builds load CommonJS dependencies without esbuild-generated
  // dynamic require shims failing at ESM import time.
  external: runtimeExternals,
};

function replacePathAliases(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      replacePathAliases(fullPath);
      continue;
    }
    if (!file.endsWith(".d.ts")) continue;

    let content = fs.readFileSync(fullPath, "utf8");
    content = content.replace(/from\s+["']@\/([^"']+)["']/g, (_match, importPath) => {
      const absolutePath = path.resolve(distDir, importPath);
      const relativePath = path.relative(path.dirname(fullPath), absolutePath);
      const normalizedPath = relativePath.split(path.sep).join("/");
      return `from "${normalizedPath.startsWith(".") ? normalizedPath : `./${normalizedPath}`}"`;
    });
    fs.writeFileSync(fullPath, content);
  }
}

function generateTypeDeclarations(): void {
  execSync(
    "pnpm exec tsc --project tsconfig.json --emitDeclarationOnly --noCheck --outDir dist",
    { cwd: baseUrl, stdio: "inherit" }
  );
  fs.rmSync(path.join(distDir, "__tests__"), { recursive: true, force: true });
  replacePathAliases(distDir);
  console.log("Generated public declarations from src/server.ts");
}

function copyRuntimeAssets(): void {
  const wasmCandidates = [
    path.join(baseUrl, "node_modules", "tiktoken", "tiktoken_bg.wasm"),
    path.resolve(baseUrl, "..", "..", "node_modules", "tiktoken", "tiktoken_bg.wasm"),
  ];
  const wasmSource = wasmCandidates.find((candidate) => fs.existsSync(candidate));
  if (wasmSource) {
    fs.copyFileSync(wasmSource, path.join(distDir, "tiktoken_bg.wasm"));
    console.log("Copied tiktoken_bg.wasm to core dist");
  } else {
    console.warn("Warning: tiktoken_bg.wasm not found, skipping");
  }

  const uiSource = path.resolve(baseUrl, "..", "ui", "dist", "index.html");
  if (fs.existsSync(uiSource)) {
    fs.copyFileSync(uiSource, path.join(distDir, "index.html"));
    console.log("Copied UI index.html to core dist");
  }
}

const cjsConfig: esbuild.BuildOptions = {
  ...baseConfig,
  outdir: "dist/cjs",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  // CJS bundles define __dirname natively; suppress the ESM-only import.meta
  // fallback so esbuild doesn't emit a build warning.
  define: { "import.meta.url": "undefined" },
};

const esmConfig: esbuild.BuildOptions = {
  ...baseConfig,
  outdir: "dist/esm",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);',
  },
};

async function build() {
  console.log("Building CJS and ESM versions...");

  if (!watch) {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    generateTypeDeclarations();
  }

  const cjsCtx = await esbuild.context(cjsConfig);
  const esmCtx = await esbuild.context(esmConfig);

  if (watch) {
    console.log("Watching for changes...");
    await Promise.all([cjsCtx.watch(), esmCtx.watch()]);
    return;
  }

  await Promise.all([cjsCtx.rebuild(), esmCtx.rebuild()]);
  await Promise.all([cjsCtx.dispose(), esmCtx.dispose()]);
  copyRuntimeAssets();

  console.log("Build completed successfully!");
  console.log("  - CJS: dist/cjs/server.cjs");
  console.log("  - ESM: dist/esm/server.mjs");
  console.log("  - Types: dist/server.d.ts");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
