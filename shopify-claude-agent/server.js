import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { searchProductsTool } from './tools/searchProducts.js';
import { createCartWithItemTool } from './tools/createCartWithItem.js';
import { createDraftOrderTool } from './tools/createDraftOrder.js';

export const SHOPIFY_SERVER_NAME = 'shopify';

export function createShopifyMcpServer(rl) {
  return createSdkMcpServer({
    name: SHOPIFY_SERVER_NAME,
    version: '1.0.0',
    tools: [searchProductsTool, createCartWithItemTool, createDraftOrderTool(rl)],
  });
}
