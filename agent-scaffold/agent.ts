/**
 * Inventory agent — a minimal Claude Agent SDK agent with one custom MCP tool.
 *
 * Run: npm start   (approve the tool call when prompted)
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import dotenv from 'dotenv';
import { z } from 'zod';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

// 1. Load ANTHROPIC_API_KEY (and anything else) from .env into process.env.
dotenv.config();

if (!process.env['ANTHROPIC_API_KEY']) {
  throw new Error('ANTHROPIC_API_KEY is missing — add it to agent-scaffold/.env');
}

// --------------------------------------------------------------------------
// 2. The custom tool, exposed through an in-process MCP server.
// --------------------------------------------------------------------------

const MOCK_STOCK: Readonly<Record<string, number>> = {
  'WB-1L': 42,
  'WB-500ML': 118,
  'TH-MUG': 7,
};

const SERVER_NAME = 'inventory-tools';
const TOOL_NAME = 'get_stock_level';

/** How the model addresses an SDK MCP tool: mcp__<server>__<tool>. */
const QUALIFIED_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}` as const;

const getStockLevel = tool(
  TOOL_NAME,
  'Look up the current warehouse stock count for a single product SKU.',
  {
    sku: z.string().min(1).describe('The product SKU to look up, e.g. "WB-1L".'),
  },
  async ({ sku }): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
    const normalized = sku.trim().toUpperCase();
    const count = MOCK_STOCK[normalized];

    if (count === undefined) {
      return {
        content: [{ type: 'text', text: `SKU ${normalized}: not found in inventory` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `SKU ${normalized}: ${count} in stock` }],
    };
  },
);

const inventoryServer = createSdkMcpServer({
  name: SERVER_NAME,
  version: '1.0.0',
  tools: [getStockLevel],
});

// --------------------------------------------------------------------------
// 4. Human-in-the-loop approval gate.
// --------------------------------------------------------------------------

/**
 * Reads one line from stdin. The interface is created per question and closed
 * again so a long-lived one can't hit EOF (piped stdin) while the agent is
 * still thinking; returns null when there is no input left to read.
 */
async function askLine(prompt: string, signal: AbortSignal): Promise<string | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt, { signal });
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** Prompts on stdin before any tool runs; anything other than y/yes denies. */
const requireApproval: CanUseTool = async (toolName, input, { signal, title }) => {
  console.log(`\n  ┌─ PERMISSION REQUEST ─────────────────────────────`);
  console.log(`  │ ${title ?? `Claude wants to use ${toolName}`}`);
  console.log(`  │ tool:  ${toolName}`);
  console.log(`  │ input: ${JSON.stringify(input)}`);
  console.log(`  └──────────────────────────────────────────────────`);

  const answer = await askLine('  approve? [y/N] ', signal);

  if (answer === null) {
    console.log('  → DENIED (no answer available on stdin)\n');
    return { behavior: 'deny', message: `No operator available to approve ${toolName}.` };
  }

  if (['y', 'yes'].includes(answer.trim().toLowerCase())) {
    console.log('  → APPROVED\n');
    return { behavior: 'allow', updatedInput: input };
  }

  console.log('  → DENIED\n');
  return { behavior: 'deny', message: `Operator denied ${toolName}.` };
};

// --------------------------------------------------------------------------
// 5. Print every turn the agent emits, not just the final answer.
// --------------------------------------------------------------------------

function printTurn(message: SDKMessage): void {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        console.log(`[init]      model=${message.model} session=${message.session_id}`);
        console.log(`[init]      tools=${message.tools.join(', ') || '(none)'}`);
        for (const server of message.mcp_servers) {
          console.log(`[init]      mcp server "${server.name}": ${server.status}`);
        }
      }
      return;

    case 'assistant':
      for (const block of message.message.content) {
        switch (block.type) {
          case 'text':
            console.log(`[assistant] ${block.text}`);
            break;
          case 'thinking':
            console.log(`[thinking]  ${block.thinking}`);
            break;
          case 'tool_use':
            console.log(`[tool_use]  ${block.name}(${JSON.stringify(block.input)})`);
            break;
          default:
            console.log(`[assistant] <${block.type} block>`);
        }
      }
      return;

    case 'user': {
      // Tool results come back to the model as a synthetic user turn.
      const content = message.message.content;
      if (typeof content === 'string') {
        console.log(`[user]      ${content}`);
        return;
      }
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? [])
                  .map((part) => (part.type === 'text' ? part.text : `<${part.type}>`))
                  .join('\n');
          const tag = block.is_error === true ? 'tool_err' : 'tool_res';
          console.log(`[${tag}]  ${text}`);
        } else if (block.type === 'text') {
          console.log(`[user]      ${block.text}`);
        }
      }
      return;
    }

    case 'result':
      console.log(`\n[result]    ${message.subtype} in ${message.duration_ms}ms`);
      console.log(`[result]    cost=$${message.total_cost_usd.toFixed(6)} turns=${message.num_turns}`);
      if (message.subtype === 'success') {
        console.log(`[result]    ${message.result}`);
      }
      return;

    default:
      // The message set grows over time; surface unknown types rather than hide them.
      console.log(`[${message.type}]`);
  }
}

// --------------------------------------------------------------------------
// 3. Run the query loop with the MCP server registered.
// --------------------------------------------------------------------------

const options: Options = {
  model: 'claude-opus-5',
  // 'default' = standard permission behaviour: every tool call that is not
  // pre-approved must be granted through canUseTool before it executes.
  permissionMode: 'default',
  canUseTool: requireApproval,
  mcpServers: { [SERVER_NAME]: inventoryServer },
  tools: [], // no built-in Claude Code tools — only the inventory MCP tool
  settingSources: [], // ignore on-disk settings so nothing silently pre-approves a tool
  allowedTools: [], // nothing is auto-allowed; the gate above sees every call
  systemPrompt: `You are an inventory assistant. Use the ${QUALIFIED_TOOL_NAME} tool to answer stock questions, then state the number plainly.`,
  maxTurns: 6,
};

async function main(): Promise<void> {
  const prompt = 'How many of SKU WB-1L do we have in stock?';
  console.log(`[prompt]    ${prompt}\n`);

  for await (const message of query({ prompt, options })) {
    printTurn(message);
  }
}

await main();
