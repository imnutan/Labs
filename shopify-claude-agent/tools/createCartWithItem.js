import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { storefrontRequest } from '../Storefrontclient.js';

const CART_CREATE_MUTATION = `
  mutation CartCreate {
    cartCreate {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

const CART_LINES_ADD_MUTATION = `
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

const InputSchema = {
  variantId: z.string().min(1),
  quantity: z.number().int().positive(),
};

const OutputSchema = z.object({
  checkoutUrl: z.string().url(),
});

export const createCartWithItem = tool(
  'create_cart_with_item',
  'Create a new Shopify cart and add one line item to it, returning the checkout URL.',
  InputSchema,
  async ({ variantId, quantity }) => {
    try {
      const createData = await storefrontRequest(CART_CREATE_MUTATION, {});
      if (createData.cartCreate.userErrors.length > 0) {
        throw new Error(JSON.stringify(createData.cartCreate.userErrors));
      }
      const cartId = createData.cartCreate.cart.id;

      const addData = await storefrontRequest(CART_LINES_ADD_MUTATION, {
        cartId,
        lines: [{ merchandiseId: variantId, quantity }],
      });
      if (addData.cartLinesAdd.userErrors.length > 0) {
        throw new Error(JSON.stringify(addData.cartLinesAdd.userErrors));
      }

      const validated = OutputSchema.parse({
        checkoutUrl: addData.cartLinesAdd.cart.checkoutUrl,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(validated) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `create_cart_with_item failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);
