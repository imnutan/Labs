import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { storefrontRequest } from '../storefrontClient.js';

const SEARCH_PRODUCTS_QUERY = `
  query SearchProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          title
          featuredImage { url altText }
          variants(first: 1) {
            edges {
              node {
                id
                price { amount currencyCode }
                availableForSale
              }
            }
          }
        }
      }
    }
  }
`;

const InputSchema = {
  query: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
};

const ProductResultSchema = z.object({
  title: z.string(),
  price: z.string(),
  variantId: z.string(),
  availableForSale: z.boolean(),
  imageUrl: z.string().url().nullable(),
  imageAlt: z.string().nullable(),
});
const OutputSchema = z.array(ProductResultSchema).max(5);

export const searchProducts = tool(
  'search_products',
  'Search the Shopify storefront catalog by free-text query and return up to 5 matching products with ' +
    'title, price, variant ID, availableForSale (whether that variant is in stock), and imageUrl. Always ' +
    "mention in your reply when a result isn't available for sale, rather than letting the shopper find " +
    'out only when update_cart fails.',
  InputSchema,
  async ({ query }) => {
    try {
      const data = await storefrontRequest(SEARCH_PRODUCTS_QUERY, {
        query,
        first: 5,
      });

      const results = data.products.edges.map(({ node }) => {
        const variant = node.variants.edges[0]?.node;
        return {
          title: node.title,
          price: variant ? `${variant.price.amount} ${variant.price.currencyCode}` : 'N/A',
          variantId: variant?.id ?? '',
          availableForSale: variant?.availableForSale ?? false,
          imageUrl: node.featuredImage?.url ?? null,
          imageAlt: node.featuredImage?.altText ?? null,
        };
      });

      const validated = OutputSchema.parse(results);

      return {
        content: [{ type: 'text', text: JSON.stringify(validated, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `search_products failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);
