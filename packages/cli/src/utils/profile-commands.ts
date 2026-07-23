import fs from "node:fs/promises";
import {
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  createProfile,
  deleteProfile,
  ensureDefaultProfile,
  getProfileConfigPath,
  getProfileConfigDir,
} from "@wengine-ai/claude-code-router-shared";

export async function handleProfileCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
    case "ls": {
      await ensureDefaultProfile();
      const profiles = await listProfiles();
      if (profiles.length === 0) {
        console.log("No profiles found.");
        return;
      }
      console.log("Configuration profiles:\n");
      for (const p of profiles) {
        const marker = p.isActive ? " (active)" : "";
        const port = p.port ? ` [port ${p.port}]` : "";
        console.log(`  ${p.name}${marker}${port}`);
      }
      console.log();
      break;
    }

    case "create":
    case "new": {
      const name = args[1];
      if (!name) {
        console.error("Usage: ccr profile create <name>");
        process.exit(1);
      }
      await createProfile(name);
      console.log(`Profile "${name}" created.`);
      break;
    }

    case "switch":
    case "use": {
      const name = args[1];
      if (!name) {
        console.error("Usage: ccr profile switch <name>");
        process.exit(1);
      }
      // Verify profile exists
      const configPath = getProfileConfigPath(name);
      try {
        await fs.access(configPath);
      } catch {
        console.error(`Profile "${name}" does not exist.`);
        process.exit(1);
      }
      await setActiveProfile(name);
      console.log(`Switched to profile "${name}".`);

      // If a server was running, stop it and restart with the new profile
      const { join } = await import("path");
      const { homedir } = await import("os");
      const { readdirSync } = await import("fs");
      const homeDir = join(homedir(), ".claude-code-router");
      const profilesDir = join(homeDir, "profiles");

      // Find and stop ALL running servers (check all profile PID files)
      const stoppedProfiles: string[] = [];
      const pidFiles = [
        join(homeDir, ".claude-code-router.pid"), // default
        join(profilesDir, name, ".claude-code-router.pid"), // target
      ];
      // Also check all other profiles
      try {
        const entries = readdirSync(profilesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            pidFiles.push(join(profilesDir, entry.name, ".claude-code-router.pid"));
          }
        }
      } catch {}

      for (const pf of pidFiles) {
        try {
          const content = await fs.readFile(pf, "utf-8");
          const pid = parseInt(content.trim());
          if (!isNaN(pid)) {
            try { process.kill(pid); } catch {}
            try { await fs.unlink(pf); } catch {}
            stoppedProfiles.push(pf);
          }
        } catch {}
      }

      if (stoppedProfiles.length > 0) {
        console.log(`Stopped ${stoppedProfiles.length} old server(s).`);
      }

      // Start server with the new profile
      {
        const { spawn } = await import("child_process");
        // In the bundled CLI, __dirname is dist/, and cli.js is also in dist/
        const cliPath = join(__dirname, "cli.js");
        const childEnv = name === "default"
          ? { ...process.env, CCR_INTERNAL_START: "1" }
          : { ...process.env, CCR_CONFIG_DIR: join(profilesDir, name), CCR_INTERNAL_START: "1" };
        const child = spawn("node", [cliPath, "start"], {
          detached: true,
          stdio: "ignore",
          env: childEnv,
        });
        child.unref();
        console.log(`Server started with profile "${name}".`);
      }
      break;
    }

    case "delete":
    case "rm": {
      const name = args[1];
      if (!name) {
        console.error("Usage: ccr profile delete <name>");
        process.exit(1);
      }
      await deleteProfile(name);
      console.log(`Profile "${name}" deleted.`);
      break;
    }

    case "show": {
      const name = args[1] || (await getActiveProfile());
      console.log(`Profile: ${name}\n`);
      try {
        if (name === "default") {
          const { readConfigFile } = await import("./index.js");
          const config = await readConfigFile();
          console.log(JSON.stringify(config, null, 2));
        } else {
          const configPath = getProfileConfigPath(name);
          const content = await fs.readFile(configPath, "utf-8");
          console.log(content);
        }
      } catch (e: any) {
        console.error(`Failed to read profile "${name}": ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case "edit": {
      const name = args[1] || (await getActiveProfile());
      const configPath = getProfileConfigPath(name);
      console.log(`Profile "${name}" config: ${configPath}`);
      break;
    }

    default:
      console.log(`
Usage: ccr profile <subcommand>

Subcommands:
  list              List all profiles
  create <name>     Create a new profile (copies active config)
  switch <name>     Switch the active profile
  delete <name>     Delete a profile
  show [name]       Show profile configuration
  edit [name]       Show config file path for editing
      `);
      break;
  }
}
