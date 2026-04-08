import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TaskSyncWebviewProvider } from "../webview/webviewProvider";
import type { AskUserDirective } from "../webview/webviewTypes";
import {
	appendAutoAppendText,
	buildFinalResponseText,
	debugLog,
} from "../webview/webviewUtils";

const IPC_DIR = path.join(os.tmpdir(), "tasksync-bridge");
const POLL_INTERVAL_MS = 500;

/**
 * Builds the assigned session instruction string (mirrors tools.ts logic).
 */
function buildAssignedSessionInstruction(sessionId: string): string {
	return `TaskSync assigned session_id "${sessionId}". Normal chat is invisible here. Use this exact session_id on every ask_user call. Do not reply in plain chat. CALL ask_user again now with session_id "${sessionId}".`;
}

interface BridgeRequest {
	id: string;
	question: string;
	session_id: string;
	timestamp: number;
}

/**
 * TaskSync IPC Bridge — watches a shared directory for request files
 * from the stdio MCP bridge and routes them through the TaskSync sidebar.
 */
export class TaskSyncIpcBridge {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private activeRequests = new Set<string>();

	constructor(private provider: TaskSyncWebviewProvider) {}

	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Start watching the IPC directory for incoming requests.
	 */
	async start(): Promise<void> {
		if (this.running) {
			debugLog("[TaskSync IPC] Bridge already running");
			return;
		}

		// Ensure IPC directory exists
		await fs.mkdir(IPC_DIR, { recursive: true });

		// Clean up any stale request/response files
		await this.cleanupStaleFiles();

		this.timer = setInterval(() => {
			this.pollForRequests();
		}, POLL_INTERVAL_MS);

		this.running = true;
		debugLog(`[TaskSync IPC] Bridge started, watching ${IPC_DIR}`);
	}

	/**
	 * Stop watching the IPC directory.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.running = false;
		debugLog("[TaskSync IPC] Bridge stopped");
	}

	/**
	 * Poll for new request files in the IPC directory.
	 */
	private async pollForRequests(): Promise<void> {
		try {
			const files = await fs.readdir(IPC_DIR);
			for (const file of files) {
				if (
					file.startsWith("request-") &&
					file.endsWith(".json") &&
					!this.activeRequests.has(file)
				) {
					this.activeRequests.add(file);
					this.handleRequestFile(file);
				}
			}
		} catch (_e) {
			// Directory might not exist yet or be temporarily inaccessible
		}
	}

	/**
	 * Handle a single request file — read it, process through the sidebar,
	 * and write the response file.
	 */
	private async handleRequestFile(filename: string): Promise<void> {
		const filepath = path.join(IPC_DIR, filename);

		try {
			const raw = await fs.readFile(filepath, "utf-8");
			const request: BridgeRequest = JSON.parse(raw);

			debugLog(
				`[TaskSync IPC] Processing request ${request.id}: ${request.question.slice(0, 80)}`,
			);

			// Process through the extension's ask_user flow
			const response = await this.handleAskUser(
				request.question,
				request.session_id,
			);

			// Write response file
			const responseFile = path.join(IPC_DIR, `response-${request.id}.json`);
			await fs.writeFile(responseFile, JSON.stringify(response));

			debugLog(`[TaskSync IPC] Response written for request ${request.id}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error(
				`[TaskSync IPC] Error handling request ${filename}:`,
				message,
			);

			// Extract request ID from filename
			const match = filename.match(/^request-(.+)\.json$/);
			if (match) {
				const responseFile = path.join(IPC_DIR, `response-${match[1]}.json`);
				await fs.writeFile(
					responseFile,
					JSON.stringify({
						session_id: "",
						response: `Error: ${message}`,
						error: true,
					}),
				);
			}
		} finally {
			this.activeRequests.delete(filename);
		}
	}

	/**
	 * Handle an ask_user invocation — bridges to the provider (same logic as mcpServer.ts).
	 */
	private async handleAskUser(
		question: string,
		rawSessionId: string,
	): Promise<Record<string, unknown>> {
		let effectiveSessionId = (
			typeof rawSessionId === "string" ? rawSessionId : ""
		).trim();

		// Treat "auto" as a bootstrap signal
		if (effectiveSessionId.toLowerCase() === "auto") {
			effectiveSessionId = "";
		}

		let autoAssignedSessionId: string | undefined;

		// Auto-assign session if missing
		if (!effectiveSessionId) {
			const assignedSession = this.provider.createSessionForMissingId();
			autoAssignedSessionId = assignedSession.id;
			effectiveSessionId = assignedSession.id;
			debugLog(
				`[TaskSync IPC] Auto-assigned session_id: ${autoAssignedSessionId}`,
			);
		}

		try {
			const result = await this.provider.waitForUserResponse(
				question,
				effectiveSessionId,
			);

			let responseText = result.value;

			// Process context attachments
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
			const resultPayload: Record<string, unknown> = {
				session_id: effectiveSessionId,
				response: finalResponse,
			};

			if (result.cancelled) {
				resultPayload.directive = {
					kind: "cancelled",
					reason: "superseded",
					action: "call_ask_user_again",
				} satisfies {
					kind: AskUserDirective["kind"];
					reason: AskUserDirective["reason"];
					action: AskUserDirective["action"];
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

			return resultPayload;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error("[TaskSync IPC] ask_user error:", message);
			return {
				session_id: effectiveSessionId,
				response: `Error: ${message}`,
				error: true,
			};
		}
	}

	/**
	 * Remove stale files (older than 5 minutes) from the IPC directory.
	 */
	private async cleanupStaleFiles(): Promise<void> {
		try {
			const files = await fs.readdir(IPC_DIR);
			const now = Date.now();
			const STALE_MS = 5 * 60 * 1000;

			for (const file of files) {
				if (
					(file.startsWith("request-") || file.startsWith("response-")) &&
					file.endsWith(".json")
				) {
					const filepath = path.join(IPC_DIR, file);
					const stat = await fs.stat(filepath);
					if (now - stat.mtimeMs > STALE_MS) {
						await fs.unlink(filepath);
						debugLog(`[TaskSync IPC] Cleaned up stale file: ${file}`);
					}
				}
			}
		} catch (_e) {
			// Ignore cleanup errors
		}
	}
}
