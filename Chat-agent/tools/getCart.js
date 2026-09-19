import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CartItemSchema } from './cartItemSchema.js';

const InputSchema = {};

const OutputSchema = z.object({
  checkoutUrl: z.string().url().nullable(),
  cartItems: z.array(CartItemSchema),
});

// Read-only counterpart to update_cart, for "what's in my cart?" questions
// that aren't themselves an add/update/remove. Same cartManager instance, so
// it reads this shopper's own cart and nobody else's.
export function createGetCartTool(cartManager) {
  return tool(
    'get_cart',
    "Look up what's currently in the shopper's cart - each item's title, price, quantity, and image, " +
      "plus the checkout URL. Read-only; call this whenever a shopper asks about their cart instead of " +
      'guessing from earlier in the conversation, since update_cart calls elsewhere may have changed it.',
    InputSchema,
    async () => {
      try {
        const { checkoutUrl, cartItems } = await cartManager.getCartItems();
        const validated = OutputSchema.parse({ checkoutUrl: checkoutUrl ?? null, cartItems });
        return {
          content: [{ type: 'text', text: JSON.stringify(validated) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `get_cart failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
