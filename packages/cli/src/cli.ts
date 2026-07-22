#!/usr/bin/env node
import { run, restartService } from "./utils";
import { showStatus } from "./utils/status";
import { executeCodeCommand, PresetConfig } from "./utils/codeCommand";
import {
  cleanupPidFile,
  isServiceRunning,
  getServiceInfo,
} from "./utils/processCheck";
import { runModelSelector } from "./utils/modelSelector";
import { activateCommand } from "./utils/activateCommand";
import { readConfigFile } from "./utils";
import { version } from "../package.json";
import { spawn, exec } from "child_process";
import {getPresetDir, loadConfigFromManifest, PID_FILE, readPresetFile, REFERENCE_COUNT_FILE} from "@wengine-ai/claude-code-router-shared";
import fs, { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseStatusLineData, StatusLineInput } from "./utils/statusline";
import {handlePresetCommand} from "./utils/preset";
import { handleInstallCommand } from "./utils/installCommand";
import {
  disableConfiguredClientsForStop,
  enableConfiguredClientsForStart,
  handleClientsCommand,
} from "./utils/clients";
import { handleProfileCommand } from "./utils/profile-commands";
import {
  getActiveProfile,
  getProfileDir,
  ensureDefaultProfile,
  listProfiles,
} from "@wengine-ai/claude-code-router-shared";


const command = process.argv[2];

// Define all known commands
const KNOWN_COMMANDS = [
  "start",
  "stop",
  "restart",
  "status",
  "statusline",
  "code",
  "model",
  "preset",
  "profile",
  "install",
  "clients",
  "activate",
  "env",
  "ui",
  "-v",
  "version",
  "-h",
  "help",
];

const HELP_TEXT = `
Usage: ccr [command] [preset-name]

Commands:
  start         Start server
  stop          Stop server (--all to stop all profiles)
  restart       Restart server
  status        Show server status
  statusline    Integrated statusline
  code          Execute claude command
  model         Interactive model selection and configuration
  model --project  Configure model routing for the current project only
  preset        Manage presets (export, install, list, delete)
  profile       Manage configuration profiles
  install       Install preset from GitHub marketplace
  clients       Manage client integrations (Claude Code, Codex)
  activate      Output environment variables for shell integration
  ui            Open the web UI in browser
  -v, version   Show version information
  -h, help      Show help information

Profiles:
  ccr profile list              List all profiles
  ccr profile create <name>     Create a new profile
  ccr profile switch <name>     Switch the active profile
  ccr profile delete <name>     Delete a profile
  ccr profile show [name]       Show profile configuration

Presets:
  Any preset directory in ~/.claude-code-router/presets/

Examples:
  ccr start
  ccr code "Write a Hello World"
  ccr my-preset "Write a Hello World"    # Use preset configuration
  ccr model
  ccr model --project                    # Configure model routing for this project only
  ccr preset export my-config            # Export current config as preset
  ccr preset install /path/to/preset     # Install a preset from directory
  ccr preset list                        # List all presets
  ccr profile create work                # Create "work" profile
  ccr profile switch work                # Switch to "work" profile
  ccr install my-preset                  # Install preset from marketplace
  ccr clients list
  ccr clients enable claudeCode codex
  eval "$(ccr activate)"  # Set environment variables globally
  ccr ui
`;

async function waitForService(
  timeout = 10000,
  initialDelay = 1000
): Promise<boolean> {
  // Wait for an initial period to let the service initialize
  await new Promise((resolve) => setTimeout(resolve, initialDelay));

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const isRunning = isServiceRunning()
    if (isRunning) {
      // Wait for an additional short period to ensure service is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function main() {
  // Read active profile and set CCR_CONFIG_DIR before any shared-dependent code.
  // Since shared constants are computed at import time, we use a helper that
  // reads the profile file directly (without shared) and returns the env override.
  const _profileEnvOverride = await (async () => {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    const _homeDir = path.join(os.homedir(), ".claude-code-router");
    const _activeProfileFile = path.join(_homeDir, "profiles", "active-profile");
    try {
      const _active = fs.readFileSync(_activeProfileFile, "utf-8").trim();
      if (_active && _active !== "default") {
        return { CCR_CONFIG_DIR: path.join(_homeDir, "profiles", _active) };
      }
    } catch {}
    return null;
  })();

  const isRunning = isServiceRunning()

  // If command is not a known command, check if it's a preset
  if (command && !KNOWN_COMMANDS.includes(command)) {
    const manifest = await readPresetFile(command);

    if (manifest) {
      // This is a preset, load its configuration
      const presetDir = getPresetDir(command);
      const config = loadConfigFromManifest(manifest, presetDir);

      // Execute code command
      const codeArgs = process.argv.slice(3); // Get remaining arguments

      // Check noServer configuration
      const shouldStartServer = config.noServer !== true;

      // Build environment variable overrides
      let envOverrides: Record<string, string> = {};

      // Handle provider configuration (supports both old and new formats)
      let provider: any = null;

      // Old format: config.provider is the provider name
      if (config.provider && typeof config.provider === 'string') {
        const globalConfig = await readConfigFile();
        provider = globalConfig.Providers?.find((p: any) => p.name === config.provider);
      }
      // New format: config.Providers is an array of providers
      else if (config.Providers && config.Providers.length > 0) {
        provider = config.Providers[0];
      }

      // If noServer is not true, use local server baseurl
      if (shouldStartServer) {
        const globalConfig = await readConfigFile();
        const port = globalConfig.PORT || 3456;
        envOverrides = {
          ...envOverrides,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/preset/${command}`,
        };
      } else if (provider) {
        // Handle api_base_url, remove /v1/messages suffix
        if (provider.api_base_url) {
          let baseUrl = provider.api_base_url;
          if (baseUrl.endsWith('/v1/messages')) {
            baseUrl = baseUrl.slice(0, -'/v1/messages'.length);
          } else if (baseUrl.endsWith('/')) {
            baseUrl = baseUrl.slice(0, -1);
          }
          envOverrides = {
            ...envOverrides,
            ANTHROPIC_BASE_URL: baseUrl,
          };
        }

        // Handle api_key
        if (provider.api_key) {
          envOverrides = {
            ...envOverrides,
            ANTHROPIC_AUTH_TOKEN: provider.api_key,
          };
        }
      }

      // Build PresetConfig
      const presetConfig: PresetConfig = {
        noServer: config.noServer,
        claudeCodeSettings: config.claudeCodeSettings,
        StatusLine: config.StatusLine
      };

      if (shouldStartServer && !isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });

        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });

        startProcess.unref();

        if (await waitForService()) {
          executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
        } else {
          console.error(
            "Service startup timeout, please manually run `ccr start` to start the service"
          );
          process.exit(1);
        }
      } else {
        // Service is already running or no need to start server
        if (shouldStartServer && !isRunning) {
          console.error("Service is not running. Please start it first with `ccr start`");
          process.exit(1);
        }
        executeCodeCommand(codeArgs, presetConfig, envOverrides, command);
      }
      return;
    } else {
      // Not a preset nor a known command
      console.log(HELP_TEXT);
      process.exit(1);
    }
  }

  switch (command) {
    case "start":
      await ensureDefaultProfile();
      if (process.env.CCR_INTERNAL_START) {
        // Child process: run server directly (already has CCR_CONFIG_DIR set)
        await run();
        try { await enableConfiguredClientsForStart(); } catch {}
      } else {
        // Parent process: spawn detached child to run in background
        const cliPath = join(__dirname, "cli.js");
        const childEnv = {
          ...(_profileEnvOverride || {}),
          ...process.env,
          CCR_INTERNAL_START: "1",
        };
        const child = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
          env: childEnv,
        });
        child.unref();
        const profileName = _profileEnvOverride
          ? (await getActiveProfile())
          : "default";
        console.log(`Server started in background (profile: ${profileName}).`);
      }
      break;
    case "stop":
      try { await disableConfiguredClientsForStop(); } catch {}
      // Compute profile paths directly (not via shared constants which may be stale)
      const _os = await import("os");
      const _path = await import("path");
      const _homeDir = _path.join(_os.homedir(), ".claude-code-router");
      const _profilesDir = _path.join(_homeDir, "profiles");
      const _activeProfileFile = _path.join(_profilesDir, "active-profile");
      let _activeName = "default";
      try { _activeName = readFileSync(_activeProfileFile, "utf-8").trim() || "default"; } catch {}

      const _getPidFile = (name: string) =>
        name === "default"
          ? _path.join(_homeDir, ".claude-code-router.pid")
          : _path.join(_profilesDir, name, ".claude-code-router.pid");

      if (process.argv[3] === "--all") {
        // Stop all profile servers
        let _stoppedCount = 0;
        try {
          const _entries = fs.readdirSync(_profilesDir, { withFileTypes: true });
          for (const _entry of _entries) {
            if (_entry.isDirectory() && !_entry.name.startsWith(".")) {
              try {
                const pid = parseInt(readFileSync(_getPidFile(_entry.name), "utf-8"));
                process.kill(pid);
                fs.unlinkSync(_getPidFile(_entry.name));
                _stoppedCount++;
              } catch {}
            }
          }
        } catch {}
        // Also stop default profile
        try {
          const pid = parseInt(readFileSync(_getPidFile("default"), "utf-8"));
          process.kill(pid);
          fs.unlinkSync(_getPidFile("default"));
          _stoppedCount++;
        } catch {}
        console.log(`Stopped ${_stoppedCount} profile server(s).`);
      } else {
        // Stop active profile's server
        const _pidFile = _getPidFile(_activeName);
        try {
          const pid = parseInt(readFileSync(_pidFile, "utf-8"));
          process.kill(pid);
          try { fs.unlinkSync(_pidFile); } catch {}
          if (existsSync(REFERENCE_COUNT_FILE)) {
            try { fs.unlinkSync(REFERENCE_COUNT_FILE); } catch {}
          }
          console.log(`Profile "${_activeName}" service has been successfully stopped.`);
        } catch (e) {
          console.log("Failed to stop the service. It may have already been stopped.");
          try { cleanupPidFile(); } catch {}
        }
      }
      break;
    case "status":
      await showStatus();
      break;
    case "statusline":
      // Read JSON input from stdin
      let inputData = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("readable", () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
          inputData += chunk;
        }
      });

      process.stdin.on("end", async () => {
        try {
          const input: StatusLineInput = JSON.parse(inputData);
          // Check if preset name is provided as argument
          const presetName = process.argv[3];
          const statusLine = await parseStatusLineData(input, presetName);
          console.log(statusLine);
        } catch (error) {
          console.error("Error parsing status line data:", error);
          process.exit(1);
        }
      });
      break;
    // ADD THIS CASE
    case "model":
      await runModelSelector({ project: process.argv.slice(3).includes("--project") });
      break;
    case "preset":
      await handlePresetCommand(process.argv.slice(3));
      break;
    case "profile":
      await handleProfileCommand(process.argv.slice(3));
      break;
    case "install":
      const presetName = process.argv[3];
      await handleInstallCommand(presetName);
      break;
    case "clients":
      await handleClientsCommand(process.argv.slice(3));
      break;
    case "activate":
    case "env":
      await activateCommand();
      break;
    case "code":
      if (!isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });

        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });

        startProcess.unref();

        if (await waitForService()) {
          const codeArgs = process.argv.slice(3);
          executeCodeCommand(codeArgs);
        } else {
          console.error(
            "Service startup timeout, please manually run `ccr start` to start the service"
          );
          process.exit(1);
        }
      } else {
        const codeArgs = process.argv.slice(3);
        executeCodeCommand(codeArgs);
      }
      break;
    case "ui":
      // Check if service is running
      if (!isRunning) {
        console.log("Service not running, starting service...");
        const cliPath = join(__dirname, "cli.js");
        const startProcess = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
        });

        startProcess.on("error", (error) => {
          console.error("Failed to start service:", error.message);
          process.exit(1);
        });

        startProcess.unref();

        if (!(await waitForService())) {
          // If service startup fails, try to start with default config
          console.log(
            "Service startup timeout, trying to start with default configuration..."
          );
          const {
            initDir,
            writeConfigFile,
            backupConfigFile,
          } = require("./utils");
          const { getDefaultClientsConfig } = require("@wengine-ai/claude-code-router-shared");

          try {
            // Initialize directories
            await initDir();

            // Backup existing config file if it exists
            const backupPath = await backupConfigFile();
            if (backupPath) {
              console.log(
                `Backed up existing configuration file to ${backupPath}`
              );
            }

            // Create a minimal default config file
            await writeConfigFile({
              PORT: 3456,
              Providers: [],
              Router: {},
              Clients: getDefaultClientsConfig(),
            });
            console.log(
              "Created minimal default configuration file at ~/.claude-code-router/config.json"
            );
            console.log(
              "Please edit this file with your actual configuration."
            );

            // Try starting the service again
            const restartProcess = spawn("node", [cliPath, "start"], {
              detached: true,
              stdio: "ignore",
            });

            restartProcess.on("error", (error) => {
              console.error(
                "Failed to start service with default config:",
                error.message
              );
              process.exit(1);
            });

            restartProcess.unref();

            if (!(await waitForService(15000))) {
              // Wait a bit longer for the first start
              console.error(
                "Service startup still failing. Please manually run `ccr start` to start the service and check the logs."
              );
              process.exit(1);
            }
          } catch (error: any) {
            console.error(
              "Failed to create default configuration:",
              error.message
            );
            process.exit(1);
          }
        }
      }

      // Get service info and open UI
      const serviceInfo = await getServiceInfo();

      // Add temporary API key as URL parameter if successfully generated
      const uiUrl = `${serviceInfo.endpoint}/ui/`;

      console.log(`Opening UI at ${uiUrl}`);

      // Open URL in browser based on platform
      const platform = process.platform;
      let openCommand = "";

      if (platform === "win32") {
        // Windows
        openCommand = `start ${uiUrl}`;
      } else if (platform === "darwin") {
        // macOS
        openCommand = `open ${uiUrl}`;
      } else if (platform === "linux") {
        // Linux
        openCommand = `xdg-open ${uiUrl}`;
      } else {
        console.error("Unsupported platform for opening browser");
        process.exit(1);
      }

      exec(openCommand, (error) => {
        if (error) {
          console.error("Failed to open browser:", error.message);
          process.exit(1);
        }
      });
      break;
    case "-v":
    case "version":
      console.log(`claude-code-router version: ${version}`);
      break;
    case "restart":
      await ensureDefaultProfile();
      if (_profileEnvOverride) {
        // Stop active profile's server first
        try { await disableConfiguredClientsForStop(); } catch {}
        const pidFile = require("@wengine-ai/claude-code-router-shared").getProfilePidFile(
          await getActiveProfile()
        );
        try {
          const pid = parseInt(readFileSync(pidFile, "utf-8"));
          process.kill(pid);
          try { fs.unlinkSync(pidFile); } catch {}
        } catch {}
        // Spawn new process with correct CCR_CONFIG_DIR
        const cliPath = join(__dirname, "cli.js");
        const child = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, ..._profileEnvOverride },
        });
        child.unref();
        console.log(`Restarting server with profile...`);
        break;
      }
      try { await disableConfiguredClientsForStop(); } catch {}
      await restartService();
      try { await enableConfiguredClientsForStart(); } catch {}
      break;
    case "-h":
    case "help":
      console.log(HELP_TEXT);
      break;
    default:
      console.log(HELP_TEXT);
      process.exit(1);
  }
}

main().catch(console.error);
