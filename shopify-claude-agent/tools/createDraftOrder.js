import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { adminRequest } from '../adminclient.js';
import { askConfirmation } from '../confirm.js';

const DRAFT_ORDER_CREATE_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl }
      userErrors { field message }
    }
  }
`;

const InputSchema = {
  variantId: z.string().min(1),
  quantity: z.number().int().positive(),
};

const OutputSchema = z.object({
  invoiceUrl: z.string().url(),
});

export const createDraftOrder = tool(
  'create_draft_order',
  'Create a Shopify draft order for one line item and return its invoice URL. Requires interactive y/n confirmation before running.',
  InputSchema,
  async ({ variantId, quantity }) => {
    const confirmed = await askConfirmation(
      `\nAbout to create a draft order for ${quantity} x ${variantId}. Proceed? (y/n): `
    );

    if (!confirmed) {
      return {
        content: [
          {
            type: 'text',
            text: 'create_draft_order declined: user did not confirm with "y".',
          },
        ],
        isError: true,
      };
    }

    try {
      const data = await adminRequest(DRAFT_ORDER_CREATE_MUTATION, {
        input: {
          lineItems: [{ variantId, quantity }],
        },
      });

      if (data.draftOrderCreate.userErrors.length > 0) {
        throw new Error(JSON.stringify(data.draftOrderCreate.userErrors));
      }

      const validated = OutputSchema.parse({
        invoiceUrl: data.draftOrderCreate.draftOrder.invoiceUrl,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(validated) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `create_draft_order failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);
