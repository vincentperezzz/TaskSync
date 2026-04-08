import * as http from "http";
import { z } from "zod";
import { debugLog } from "../webview/webviewUtils";

// Use require for CommonJS compatibility with the MCP SDK
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
	SSEServerTransport,
} = require("@modelcontextprotocol/sdk/server/sse.js");

import type { TaskSyncWebviewProvider } from "../webview/webviewProvider";
import type { AskUserDirective } from "../webview/webviewTypes";
import {
	appendAutoAppendText,
	buildFinalResponseText,
} from "../webview/webviewUtils";

const DEFAULT_MCP_PORT = 3580;

/**
 * Builds the assigned session instruction string (mirrors tools.ts logic).
 */
function buildAssignedSessionInstruction(sessionId: string): string {
	return `TaskSync assigned session_id "${sessionId}". Normal chat is invisible here. Use this exact session_id on every ask_user call. Do not reply in plain chat. CALL ask_user again now with session_id "${sessionId}".`;
}

/**
 * TaskSync MCP Server — exposes the ask_user tool via MCP protocol (SSE transport).
 * Antigravity and other MCP-compatible clients can connect to this server
 * to interact with the TaskSync sidebar UI.
 */
export class TaskSyncMcpServer {
	private server: http.Server | null = null;
	private mcpServer: InstanceType<typeof McpServer> | null = null;
	private transport: InstanceType<typeof SSEServerTransport> | null = null;
	private running = false;
	private port = DEFAULT_MCP_PORT;

	constructor(private provider: TaskSyncWebviewProvider) {}

	isRunning(): boolean {
		return this.running;
	}

	getPort(): number {
		return this.port;
	}

	/**
	 * Start the MCP server on the given port.
	 * Creates an HTTP server with two endpoints:
	 *   GET  /sse      — SSE stream (MCP connection)
	 *   POST /messages — Client-to-server messages
	 */
	async start(port: number = DEFAULT_MCP_PORT): Promise<void> {
		if (this.running) {
			debugLog("[TaskSync MCP] Server already running on port", this.port);
			return;
		}

		this.port = port;

		// Create the MCP server with ask_user tool
		this.mcpServer = new McpServer(
			{
				name: "tasksync",
				version: "3.0.11",
			},
			{
				instructions:
					"TaskSync human-in-the-loop server. Call the ask_user tool to communicate with the user through the TaskSync sidebar UI. The user can ONLY see messages sent through ask_user — they cannot see your regular chat responses. You MUST call ask_user in a continuous loop.",
			},
		);

		this.registerTools();

		// Create HTTP server with SSE transport
		this.server = http.createServer(
			async (
				req: http.IncomingMessage,
				res: http.ServerResponse,
			): Promise<void> => {
				// CORS headers for MCP clients
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

				if (req.method === "OPTIONS") {
					res.writeHead(204);
					res.end();
					return;
				}

				const url = new URL(req.url || "/", `http://localhost:${this.port}`);

				if (url.pathname === "/sse" && req.method === "GET") {
					debugLog("[TaskSync MCP] SSE connection request");
					this.transport = new SSEServerTransport("/messages", res);
					await this.mcpServer!.connect(this.transport);
					debugLog("[TaskSync MCP] SSE connection established");
					return;
				}

				if (url.pathname === "/messages" && req.method === "POST") {
					if (!this.transport) {
						res.writeHead(400);
						res.end("No SSE connection established");
						return;
					}
					await this.transport.handlePostMessage(req, res);
					return;
				}

				// Health check endpoint
				if (url.pathname === "/health" && req.method === "GET") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							status: "ok",
							server: "tasksync-mcp",
							port: this.port,
						}),
					);
					return;
				}

				res.writeHead(404);
				res.end("Not found");
			},
		);

		return new Promise((resolve, reject) => {
			this.server!.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					reject(new Error(`MCP port ${this.port} is in use`));
				} else {
					reject(err);
				}
			});

			this.server!.listen(this.port, "127.0.0.1", () => {
				this.running = true;
				debugLog(
					`[TaskSync MCP] Server started on http://127.0.0.1:${this.port}`,
				);
				resolve();
			});
		});
	}

	/**
	 * Register the ask_user MCP tool.
	 */
	private registerTools(): void {
		if (!this.mcpServer) return;

		this.mcpServer.tool(
			"ask_user",
			'This is your ONLY communication channel with the user. The user CANNOT see your chat responses — they can ONLY see messages sent through this tool. You MUST call this tool in a continuous loop: 1) Call ask_user to show your question/status to the user. 2) Receive the user\'s response. 3) Do the requested work. 4) Call ask_user AGAIN with the results. 5) Repeat from step 2. NEVER end your turn without calling this tool. session_id is REQUIRED on every call. On your FIRST call, use session_id "auto". On subsequent calls, reuse the session_id from the previous result.',
			{
				question: z
					.string()
					.describe("The question or prompt to display to the user"),
				session_id: z
					.string()
					.describe(
						'REQUIRED. On your FIRST call, use "auto". On subsequent calls, use the exact session_id from the previous result.',
					),
			},
			async (args: { question: string; session_id: string }) => {
				return this.handleAskUser(args.question, args.session_id);
			},
		);

		debugLog("[TaskSync MCP] ask_user tool registered");
	}

	/**
	 * Handle an ask_user invocation through MCP — bridges to the provider.
	 */
	private async handleAskUser(
		question: string,
		rawSessionId: string,
	): Promise<{ content: Array<{ type: "text"; text: string }> }> {
		let effectiveSessionId = (
			typeof rawSessionId === "string" ? rawSessionId : ""
		).trim();

		// Treat "auto" as a bootstrap signal
		if (effectiveSessionId.toLowerCase() === "auto") {
			effectiveSessionId = "";
		}

		let autoAssignedSessionId: string | undefined;

		debugLog(
			"[TaskSync MCP] ask_user invoked — session_id:",
			effectiveSessionId || "<missing>",
			"question:",
			question.slice(0, 80),
		);

		// Auto-assign session if missing
		if (!effectiveSessionId) {
			const assignedSession = this.provider.createSessionForMissingId();
			autoAssignedSessionId = assignedSession.id;
			effectiveSessionId = assignedSession.id;
			debugLog(
				"[TaskSync MCP] askUser — auto-assigned session_id:",
				autoAssignedSessionId,
			);
		}

		try {
			const result = await this.provider.waitForUserResponse(
				question,
				effectiveSessionId,
			);

			let responseText = result.value;

			// Process context attachments (same logic as tools.ts)
			if (result.attachments && result.attachments.length > 0) {
				for (const att of result.attachments) {
					if (att.uri.startsWith("context://")) {
						responseText += `\n\n[Attached Context: ${att.name}]\n`;
						const content = await this.provider.resolveContextContent(att.uri);
						responseText += content
							? content
							: "(Context content not available)";
						responseText += "\n[End of Context]\n";
					}
				}
			}

			if (autoAssignedSessionId) {
				responseText = appendAutoAppendText(
					responseText,
					buildAssignedSessionInstruction(autoAssignedSessionId),
				);
			}

			// Build response with auto-append logic
			const respondingSession =
				this.provider._sessionManager?.getSession?.(effectiveSessionId);
			const finalResponse = buildFinalResponseText(
				responseText,
				respondingSession?.autoAppendEnabled === true,
				typeof respondingSession?.autoAppendText === "string"
					? respondingSession.autoAppendText
					: "",
				this.provider._alwaysAppendReminder,
			);

			// Build result payload (matches tools.ts format)
			const resultPayload: {
				session_id: string;
				response: string;
				directive?: {
					kind: AskUserDirective["kind"];
					reason: AskUserDirective["reason"];
					action: AskUserDirective["action"];
					session_id?: string;
				};
				queued?: boolean;
				attachmentCount?: number;
			} = {
				session_id: effectiveSessionId,
				response: finalResponse,
			};

			if (result.cancelled) {
				resultPayload.directive = {
					kind: "cancelled",
					reason: "superseded",
					action: "call_ask_user_again",
				};
			} else if (autoAssignedSessionId) {
				resultPayload.directive = {
					kind: "bootstrap",
					reason: "auto_assigned_session",
					action: "call_ask_user_again",
					session_id: effectiveSessionId,
				};
			} else if (result.directive) {
				resultPayload.directive = {
					kind: result.directive.kind,
					reason: result.directive.reason,
					action: result.directive.action,
					...(result.directive.sessionId
						? { session_id: result.directive.sessionId }
						: {}),
				};
			}

			if (result.queue) {
				resultPayload.queued = true;
			}

			const validAttachments = (result.attachments || []).filter(
				(att) => !att.uri.startsWith("context://"),
			);
			if (validAttachments.length > 0) {
				resultPayload.attachmentCount = validAttachments.length;
			}

			debugLog(
				"[TaskSync MCP] ask_user — returning result (response length:",
				finalResponse.length,
				")",
			);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(resultPayload),
					},
				],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error("[TaskSync MCP] ask_user error:", message);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							session_id: effectiveSessionId,
							response: `Error: ${message}`,
							error: true,
						}),
					},
				],
			};
		}
	}

	/**
	 * Stop the MCP server.
	 */
	stop(): void {
		if (this.transport) {
			this.transport.close().catch(() => {});
			this.transport = null;
		}
		if (this.mcpServer) {
			this.mcpServer.close().catch(() => {});
			this.mcpServer = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		this.running = false;
		debugLog("[TaskSync MCP] Server stopped");
	}
}
