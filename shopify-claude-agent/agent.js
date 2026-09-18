import "dotenv/config";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { searchProducts } from "./tools/searchProducts.js";
import { createCartWithItem } from "./tools/createCartWithItem.js";
import { createDraftOrder } from "./tools/createDraftOrder.js";
import { rl } from "./confirm.js";
const shopifyServer = createSdkMcpServer({ 
										 name: "shopify-tools", 
										 tools: [searchProducts, createCartWithItem, createDraftOrder],
										 });
let turnComplete = () => {};
let turnCompletePromise = new Promise((resolve) => { turnComplete = resolve; });
async function* userMessages() { 
console.log("Shopify agent ready. Type a message (Ctrl+C to quit).\n"); 
while (true) { 
const text = await rl.question("You: "); 
yield { type: "user", message: { role: "user", content: text } }; 
// Wait for the SDK to signal this turn is fully done - including any 
// tool-side confirmation prompt - before looping back to ask again. 
// Otherwise this rl.question("You: ") races askConfirmation's own 
// rl.question() call inside createDraftOrder, and the real answer 
// (and the resulting invoiceUrl) gets silently swallowed. 
await turnCompletePromise; 
turnCompletePromise = new Promise((resolve) => { turnComplete = resolve; }); 
}
}
async function main() { 
const stream = query({ 
					 prompt: userMessages(), 
					 options: { 
					 mcpServers: { shopify: shopifyServer }, 
					 allowedTools: [ 
									"mcp__shopify__search_products", 
									"mcp__shopify__create_cart_with_item", 
									"mcp__shopify__create_draft_order", 
									], 
					 systemPrompt: 
					 "You are a helpful Shopify shopping and order assistant. " + "Use the available tools for anything involving real product, cart, or order data.",
					 }, 
					 }); 
for await (const message of stream) { 
if (message.type === "assistant") { 
const text = message.message.content 
.filter((block) => block.type === "text") 
.map((block) => block.text) 
.join(""); 
if (text) console.log("Agent:", text, "\n"); 
} 
if (message.type === "result") { 
turnComplete(); 
} 
}
}
main();