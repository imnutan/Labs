import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CartItemSchema } from './cartItemSchema.js';

const InputSchema = {
  code: z.string().min(1),
};

const OutputSchema = z.object({
  checkoutUrl: z.string().url().nullable(),
  cartItems: z.array(CartItemSchema),
});

// cartManager is the same per-session instance update_cart uses, so this
// applies the code to the shopper's own already-tracked cart - the model
// never sees or passes a cart ID itself.
export function createApplyDiscountCodeTool(cartManager) {
  return tool(
    'apply_discount_code',
    "Apply a discount code to the shopper's current cart. Requires at least one item already in the " +
      'cart - add one with update_cart first if the cart is empty. Returns the checkout URL with the ' +
      "discount reflected, plus the cart's current items; if the code is invalid or expired, this " +
      'reports the error instead.',
    InputSchema,
    async ({ code }) => {
      try {
        const { checkoutUrl, cartItems } = await cartManager.applyDiscountCode(code);
        const validated = OutputSchema.parse({ checkoutUrl: checkoutUrl ?? null, cartItems });
        return {
          content: [{ type: 'text', text: JSON.stringify(validated) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `apply_discount_code failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
