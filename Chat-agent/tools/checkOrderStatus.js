import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { adminRequest } from '../adminClient.js';

const ORDER_STATUS_QUERY = `
  query CheckOrderStatus($query: String!) {
    orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          name
          displayFinancialStatus
          displayFulfillmentStatus
        }
      }
    }
  }
`;

const InputSchema = {
  email: z.string().email(),
};

const OrderResultSchema = z.object({
  name: z.string(),
  financialStatus: z.string(),
  fulfillmentStatus: z.string(),
});
const OutputSchema = z.array(OrderResultSchema).max(10);

export const checkOrderStatus = tool(
  'check_order_status',
  "Look up a shopper's most recent orders by email and return each order's name, financial status " +
    '(e.g. paid, pending, refunded), and fulfillment status (e.g. fulfilled, unfulfilled). Read-only - ' +
    "this never places or changes an order, only reports what's actually recorded in Shopify. Ask the " +
    'shopper for their email before calling this if you do not already have it.',
  InputSchema,
  async ({ email }) => {
    try {
      const data = await adminRequest(ORDER_STATUS_QUERY, { query: `email:${email}` });

      const results = data.orders.edges.map(({ node }) => ({
        name: node.name,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
      }));

      const validated = OutputSchema.parse(results);

      return {
        content: [{ type: 'text', text: JSON.stringify(validated, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `check_order_status failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);
