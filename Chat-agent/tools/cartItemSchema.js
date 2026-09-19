import { z } from 'zod';

// Shared by every tool that returns cart contents (update_cart,
// apply_discount_code, get_cart), so the shopper-facing shape stays
// identical no matter which tool call produced it.
export const CartItemSchema = z.object({
  variantId: z.string(),
  title: z.string(),
  price: z.string(),
  quantity: z.number().int(),
  imageUrl: z.string().url().nullable(),
  imageAlt: z.string().nullable(),
});
