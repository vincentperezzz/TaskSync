#!/usr/bin/env node
/**
 * TaskSync MCP Stdio Bridge for Antigravity
 *
 * This is a standalone MCP server using stdio transport.
 * Antigravity spawns this process and communicates via stdin/stdout.
 *
 * It bridges to the TaskSync extension via file-based IPC:
 * - Writes request files to a shared IPC directory
 * - Extension picks them up and shows questions in the sidebar
 * - Extension writes response files when the user answers
 * - This script reads the response and returns it via MCP
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomBytes } = require("crypto");
const readline = require("readline");

// ─── IPC Configuration ───
const IPC_DIR = path.join(os.tmpdir(), "tasksync-bridge");
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Ensure IPC directory exists
if (!fs.existsSync(IPC_DIR)) {
	fs.mkdirSync(IPC_DIR, { recursive: true });
}

// ─── MCP Stdio Transport ───
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(message) {
	const json = JSON.stringify(message);
	process.stdout.write(json + "\n");
}

rl.on("line", (line) => {
	if (!line.trim()) return;
	try {
		const msg = JSON.parse(line);
		handleMessage(msg);
	} catch (e) {
		process.stderr.write(`[TaskSync Bridge] Parse error: ${e.message}\n`);
	}
});

// ─── MCP Message Handler ───
async function handleMessage(msg) {
	switch (msg.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "tasksync-bridge", version: "1.0.0" },
				},
			});
			break;

		case "notifications/initialized":
			process.stderr.write(
				`[TaskSync Bridge] Initialized. IPC dir: ${IPC_DIR}\n`,
			);
			break;

		case "tools/list":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					tools: [
						{
							name: "ask_user",
							description:
								'Ask the user a question through the TaskSync sidebar. This is your ONLY communication channel with the user. You MUST call this tool to communicate. The user CANNOT see your chat responses. session_id is REQUIRED on every call. On your FIRST call, use session_id "auto".',
							inputSchema: {
								type: "object",
								properties: {
									question: {
										type: "string",
										description:
											"The question or message to display to the user",
									},
									session_id: {
										type: "string",
										description:
											'Session ID. Use "auto" on first call. Reuse the returned session_id on subsequent calls.',
									},
								},
								required: ["question", "session_id"],
							},
						},
					],
				},
			});
			break;

		case "tools/call":
			await handleToolCall(msg);
			break;

		default:
			if (msg.id) {
				send({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: `Method not found: ${msg.method}` },
				});
			}
	}
}

// ─── Tool Call Handler ───
async function handleToolCall(msg) {
	const { name, arguments: args } = msg.params;

	if (name !== "ask_user") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
				isError: true,
			},
		});
		return;
	}

	const question = args.question || "No question provided";
	const sessionId = args.session_id || "auto";
	const requestId = randomBytes(8).toString("hex");

	process.stderr.write(
		`[TaskSync Bridge] ask_user called (request: ${requestId}, session: ${sessionId})\n`,
	);

	try {
		// Write request file for the extension to pick up
		const requestFile = path.join(IPC_DIR, `request-${requestId}.json`);
		const requestData = {
			id: requestId,
			question,
			session_id: sessionId,
			timestamp: Date.now(),
		};
		fs.writeFileSync(requestFile, JSON.stringify(requestData));

		process.stderr.write(
			`[TaskSync Bridge] Request written, waiting for response...\n`,
		);

		// Wait for response file from the extension
		const response = await waitForResponse(requestId);

		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				content: [
					{
						type: "text",
						text: JSON.stringify(response),
					},
				],
			},
		});
	} catch (e) {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				content: [{ type: "text", text: `Error: ${e.message}` }],
				isError: true,
			},
		});
	}
}

// ─── Wait for Response ───
function waitForResponse(requestId) {
	return new Promise((resolve, reject) => {
		const responseFile = path.join(IPC_DIR, `response-${requestId}.json`);
		const startTime = Date.now();

		const checkInterval = setInterval(() => {
			try {
				if (fs.existsSync(responseFile)) {
					const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
					clearInterval(checkInterval);

					// Clean up IPC files
					try {
						fs.unlinkSync(path.join(IPC_DIR, `request-${requestId}.json`));
					} catch (_e) {
						/* ignore */
					}
					try {
						fs.unlinkSync(responseFile);
					} catch (_e) {
						/* ignore */
					}

					resolve(data);
				} else if (Date.now() - startTime > POLL_TIMEOUT_MS) {
					clearInterval(checkInterval);
					try {
						fs.unlinkSync(path.join(IPC_DIR, `request-${requestId}.json`));
					} catch (_e) {
						/* ignore */
					}
					reject(new Error("Timed out waiting for user response"));
				}
			} catch (e) {
				clearInterval(checkInterval);
				reject(e);
			}
		}, POLL_INTERVAL_MS);
	});
}

// ─── Cleanup on exit ───
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

process.stderr.write(
	`[TaskSync Bridge] MCP stdio server started. IPC dir: ${IPC_DIR}\n`,
);
