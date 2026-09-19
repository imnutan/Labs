import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CartItemSchema } from './cartItemSchema.js';

const InputSchema = {
  variantId: z.string().min(1),
  quantity: z.number().int().min(0),
};

const OutputSchema = z.object({
  checkoutUrl: z.string().url().nullable(),
  cartItems: z.array(CartItemSchema),
});

// cartManager is bound per shopper session, so the tool always reads and
// writes that shopper's own cart - the model itself never sees a cart or
// line ID, only the variantId/quantity it already has from search_products.
export function createUpdateCartTool(cartManager) {
  return tool(
    'update_cart',
    "Add, update, or remove a line in the shopper's cart by product variant ID and quantity. Quantity 0 " +
      'removes that variant from the cart. Returns the checkout URL and every item currently in the cart ' +
      '(title, price, quantity, image) so you can confirm exactly what the cart now holds.',
    InputSchema,
    async ({ variantId, quantity }) => {
      try {
        const { checkoutUrl, cartItems } = await cartManager.addOrSetQuantity(variantId, quantity);
        const validated = OutputSchema.parse({ checkoutUrl: checkoutUrl ?? null, cartItems });
        return {
          content: [{ type: 'text', text: JSON.stringify(validated) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `update_cart failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
