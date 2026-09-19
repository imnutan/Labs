import 'dotenv/config';
import express from 'express';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { searchProducts } from './tools/searchProducts.js';
import { createUpdateCartTool } from './tools/updateCart.js';
import { createApplyDiscountCodeTool } from './tools/applyDiscountCode.js';
import { createGetCartTool } from './tools/getCart.js';
import { checkOrderStatus } from './tools/checkOrderStatus.js';
import { createCartManager } from './cartState.js';
import { storefrontRequest } from './storefrontClient.js';
import { ChatSession } from './chatSession.js';

const SHOPIFY_SERVER_NAME = 'shopify';
const ALLOWED_TOOLS = [
  `mcp__${SHOPIFY_SERVER_NAME}__search_products`,
  `mcp__${SHOPIFY_SERVER_NAME}__update_cart`,
  `mcp__${SHOPIFY_SERVER_NAME}__apply_discount_code`,
  `mcp__${SHOPIFY_SERVER_NAME}__get_cart`,
  `mcp__${SHOPIFY_SERVER_NAME}__check_order_status`,
];
const SESSION_IDLE_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map();

function getOrCreateSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    // update_cart closes over this shopper's own cart manager, so the MCP
    // server (and the query() it's wired to) is built fresh per session -
    // the tool can never reach into another shopper's cart.
    const cartManager = createCartManager(storefrontRequest);
    const shopifyServer = createSdkMcpServer({
      name: SHOPIFY_SERVER_NAME,
      version: '1.0.0',
      tools: [
        searchProducts,
        createUpdateCartTool(cartManager),
        createApplyDiscountCodeTool(cartManager),
        createGetCartTool(cartManager),
        checkOrderStatus,
      ],
    });

    session = new ChatSession({
      mcpServers: { [SHOPIFY_SERVER_NAME]: shopifyServer },
      // query()'s default permission mode prompts for confirmation before
      // running a tool; allowedTools is what lets these tools run without
      // stalling on that prompt, same as in the terminal agent.
      allowedTools: ALLOWED_TOOLS,
      systemPrompt:
        'You are a helpful Shopify shopping assistant for one shopper. You have no tools besides ' +
        'search_products, update_cart, apply_discount_code, get_cart, and check_order_status, and no ' +
        'access to files or workspaces - never claim to check them.\n\n' +
        "The shopper's chat interface already renders every search_products, update_cart, " +
        'apply_discount_code, and get_cart result as its own visual card: image, title, price, ' +
        '(availableForSale as a "Sold out" badge on search results), and either an Add to Cart button ' +
        '(search results) or a quantity and Remove button plus a checkout link (cart contents). Because ' +
        'of that, your text reply must NEVER restate those as a list, table, or bullets of names/prices/' +
        'statuses/quantities - that would just duplicate the cards. Keep the reply to one short ' +
        "conversational sentence introducing or following up on what the cards already show (e.g. \"Here's " +
        'what I found:", "Added to your cart - ready when you are.", "That one\'s sold out, but here are a ' +
        'few in stock."). This does not apply to check_order_status, which has no card - describe its ' +
        'result in text as normal.\n\n' +
        'For any question about what the store sells or has in stock, call search_products before ' +
        'answering, even for vague questions - try a few relevant keywords rather than asking the shopper ' +
        'to narrow down first. Use update_cart to add, change, or remove items once the shopper has picked ' +
        'a variantId from search results; you never see or need a cart or line ID yourself. If a shopper ' +
        'asks what is in their cart, call get_cart rather than answering from memory - update_cart calls ' +
        'earlier in the conversation may not reflect the current state. Use apply_discount_code once the ' +
        'shopper has at least one item in the cart. You have no way to know, at the moment update_cart or ' +
        'checkout happens, whether an order actually went through - checkout completion happens outside ' +
        'this conversation. So never tell a shopper an order succeeded, failed, shipped, or is in any ' +
        'state unless you just called check_order_status and are reporting what it returned. If a shopper ' +
        "asks whether an order went through, or about an order's status, and you do not already have " +
        'their email from this conversation, ask for it before calling check_order_status - never guess or ' +
        'reuse an email from a different shopper.',
    });
    sessions.set(sessionId, session);
  }
  return session;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActiveAt > SESSION_IDLE_MS) {
      sessions.delete(sessionId);
      session.close();
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

const app = express();
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body ?? {};

  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const session = getOrCreateSession(sessionId);
    const { text, products, cartItems, checkoutUrl } = await session.send(message);
    res.json({ sessionId, reply: text, products, cartItems, checkoutUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Shopify chat backend listening on port ${PORT}`);
  });
}

export { app, sessions };
