import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Install the bundled mcp-expert workflow into Antigravity's global_workflows directory.
 * Silently updates the workflow if the bundled version differs from the installed one.
 */
async function installWorkflow(
	context: vscode.ExtensionContext,
): Promise<void> {
	const homeDir = os.homedir();
	const antigravityDir = path.join(homeDir, ".gemini", "antigravity");
	const workflowsDir = path.join(antigravityDir, "global_workflows");
	const targetPath = path.join(workflowsDir, "mcp-expert.md");

	// Source workflow bundled with the extension
	const sourcePath = path.join(
		context.extensionPath,
		"workflows",
		"mcp-expert.md",
	);

	// Verify the source file exists in the extension bundle
	try {
		await fs.stat(sourcePath);
	} catch {
		// Workflow not bundled (dev environment?), skip silently
		return;
	}

	// Check if the Antigravity directory exists — if not, user doesn't have Antigravity
	try {
		await fs.stat(antigravityDir);
	} catch {
		return;
	}

	const bundledContent = await fs.readFile(sourcePath, "utf-8");

	// Check if the workflow is already installed and up to date
	try {
		const existingContent = await fs.readFile(targetPath, "utf-8");
		if (existingContent === bundledContent) {
			// Already installed and up to date
			return;
		}
	} catch {
		// File doesn't exist yet, proceed with installation
	}

	// Ensure the global_workflows directory exists
	await fs.mkdir(workflowsDir, { recursive: true });

	// Write the workflow file
	await fs.writeFile(targetPath, bundledContent, "utf-8");
}

export async function promptInstallAntigravityMcp(
	context: vscode.ExtensionContext,
): Promise<void> {
	try {
		const homeDir = os.homedir();
		const antigravityDir = path.join(homeDir, ".gemini", "antigravity");
		const mcpConfigPath = path.join(antigravityDir, "mcp_config.json");

		// Check if directory exists
		try {
			await fs.stat(antigravityDir);
		} catch {
			// Directory doesn't exist, ignore
			return;
		}

		// Install workflow file (silently, no prompt needed)
		await installWorkflow(context);

		// The path to the stdio bridge we want to configure
		const bridgeScriptPath = path.join(
			context.extensionPath,
			"mcp",
			"stdio-bridge.js",
		);

		let currentConfig: any = { mcpServers: {} };

		// Read existing config if it exists
		try {
			const stat = await fs.stat(mcpConfigPath);
			if (stat.isFile()) {
				const raw = await fs.readFile(mcpConfigPath, "utf-8");
				currentConfig = JSON.parse(raw);
			}
		} catch (e) {
			// File doesn't exist or isn't parseable, that's fine
		}

		if (!currentConfig.mcpServers) {
			currentConfig.mcpServers = {};
		}

		const existingTaskSyncServer = currentConfig.mcpServers["tasksync"];

		// Check if it's already configured correctly
		if (
			existingTaskSyncServer &&
			existingTaskSyncServer.command === "node" &&
			Array.isArray(existingTaskSyncServer.args) &&
			existingTaskSyncServer.args[0] === bridgeScriptPath
		) {
			// Already configured correctly, do nothing
			return;
		}

		// Ask the user if they want to integrate
		const message = existingTaskSyncServer
			? "TaskSync detected that Antigravity's MCP configuration is pointing to an old extension path. Would you like to update it automatically?"
			: "TaskSync can integrate directly with Antigravity! Would you like to automatically configure it?";

		const choice = await vscode.window.showInformationMessage(
			message,
			"Yes, Configure",
			"No",
		);

		if (choice === "Yes, Configure") {
			currentConfig.mcpServers["tasksync"] = {
				command: "node",
				args: [bridgeScriptPath],
			};

			await fs.writeFile(
				mcpConfigPath,
				JSON.stringify(currentConfig, null, 2) + "\n",
				"utf-8",
			);
			vscode.window.showInformationMessage(
				"Antigravity MCP properly configured for TaskSync!",
			);
		}
	} catch (err) {
		console.error("[TaskSync] Error during MCP install check:", err);
	}
}
