---
description: TaskSync human-in-the-loop integration for Antigravity. ALWAYS ACTIVE — every conversation MUST use the ask_user MCP tool as the primary communication channel. The user CANNOT see regular chat responses.
---

# TaskSync MCP Integration — ALWAYS ON

TaskSync provides a human-in-the-loop sidebar UI in VS Code. The `ask_user` MCP tool is your **ONLY** communication channel with the user. **The user CANNOT see your regular chat responses — they are invisible.** You MUST always use `ask_user` to communicate.

## How It Works

1. The TaskSync VS Code extension starts an MCP server on `http://127.0.0.1:3581/sse`
2. Antigravity connects to it automatically via the MCP config
3. You call the `ask_user` tool to display questions/messages in the TaskSync sidebar
4. The user responds through the sidebar → the response flows back to you

## Critical Rules — ALWAYS ENFORCED

> [!CAUTION]
> These rules apply to **EVERY conversation**, not just when `/mcp-expert` is invoked. They are non-negotiable.

1. **ALWAYS call `ask_user`**: Every single turn MUST include at least one `ask_user` call. No exceptions.
2. **The user CANNOT see regular chat**: Your markdown responses in the chat panel are **invisible** to the user. The ONLY way they can see your output is through `ask_user`.
3. **NEVER end your turn without `ask_user`**: After completing any task (code edits, file creation, commands, etc.), you MUST call `ask_user` to report results and ask what's next.
4. **NEVER stop the loop**: Do NOT end the conversation loop. After every user response, continue calling `ask_user`. The loop is perpetual.
5. **If `ask_user` fails, retry**: If the tool call fails or times out, retry immediately. Do not fall back to regular chat.
6. **No exit conditions**: There are NO stop words. The user will close the session manually if they want to stop. You must keep calling `ask_user` indefinitely.

## Tool Usage

### ask_user Tool
- **question** (string, required): The question or message to display to the user
- **session_id** (string, required): Use `"auto"` on your FIRST call. Reuse the `session_id` from the previous response on all subsequent calls.

### Session ID Flow
1. First call: `session_id: "auto"` → response includes assigned `session_id`
2. Subsequent calls: reuse the exact `session_id` from the previous result
3. During context summarization, ALWAYS preserve the `session_id`

### Response Format
The tool returns a JSON payload:
```json
{
  "session_id": "assigned-session-id",
  "response": "user's response text",
  "directive": { "kind": "bootstrap", "action": "call_ask_user_again" },
  "queued": false,
  "attachmentCount": 0
}
```

## Workflow Pattern

Every turn should follow this pattern:
1. Read the user's request (from `ask_user` response)
2. Do the work (edit files, run commands, search, etc.)
3. Call `ask_user` with a summary of what you did + ask what's next
4. Wait for user response
5. GOTO step 1 — **never break this loop**
