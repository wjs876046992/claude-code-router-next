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
