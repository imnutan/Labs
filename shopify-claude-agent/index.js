import 'dotenv/config';
import readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createShopifyMcpServer, SHOPIFY_SERVER_NAME } from './server.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const shopifyServer = createShopifyMcpServer(rl);

const ALLOWED_TOOLS = [
  `mcp__${SHOPIFY_SERVER_NAME}__search_products`,
  `mcp__${SHOPIFY_SERVER_NAME}__create_cart_with_item`,
  `mcp__${SHOPIFY_SERVER_NAME}__create_draft_order`,
];

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Gates the REPL's next prompt on the SDK's own 'result' message so it
// can't race the draft-order tool's y/n confirmation on the same rl.
let turnComplete = Promise.resolve();
let resolveTurnComplete;

function startTurn() {
  turnComplete = new Promise((resolve) => {
    resolveTurnComplete = resolve;
  });
}

async function* userMessageGenerator() {
  while (true) {
    await turnComplete;

    const input = await ask('\nYou: ');
    const trimmed = input.trim();

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      return;
    }
    if (!trimmed) {
      continue;
    }

    startTurn();

    yield {
      type: 'user',
      message: { role: 'user', content: trimmed },
      parent_tool_use_id: null,
    };
  }
}

async function main() {
  console.log('Shopify agent ready. Type a message, or "exit" to quit.');

  const stream = query({
    prompt: userMessageGenerator(),
    options: {
      mcpServers: { [SHOPIFY_SERVER_NAME]: shopifyServer },
      allowedTools: ALLOWED_TOOLS,
    },
  });

  for await (const message of stream) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          console.log(`\nClaude: ${block.text}`);
        }
      }
    } else if (message.type === 'result') {
      resolveTurnComplete?.();
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
