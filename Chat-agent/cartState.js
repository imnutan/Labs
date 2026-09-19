const CART_LINE_FIELDS = `
  id
  quantity
  merchandise {
    ... on ProductVariant {
      id
      title
      price { amount currencyCode }
      image { url altText }
      product { title }
    }
  }
`;

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
      cart {
        id
        checkoutUrl
        lines(first: 250) {
          edges { node { ${CART_LINE_FIELDS} } }
        }
      }
      userErrors { field message }
    }
  }
`;

const CART_LINES_UPDATE_MUTATION = `
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart {
        id
        checkoutUrl
        lines(first: 250) {
          edges { node { ${CART_LINE_FIELDS} } }
        }
      }
      userErrors { field message }
    }
  }
`;

const CART_LINES_REMOVE_MUTATION = `
  mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart {
        id
        checkoutUrl
        lines(first: 250) {
          edges { node { ${CART_LINE_FIELDS} } }
        }
      }
      userErrors { field message }
    }
  }
`;

const CART_DISCOUNT_CODES_UPDATE_MUTATION = `
  mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]) {
    cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
      cart {
        id
        checkoutUrl
        lines(first: 250) {
          edges { node { ${CART_LINE_FIELDS} } }
        }
      }
      userErrors { field message }
    }
  }
`;

const CART_QUERY = `
  query GetCart($cartId: ID!) {
    cart(id: $cartId) {
      id
      checkoutUrl
      lines(first: 250) {
        edges { node { ${CART_LINE_FIELDS} } }
      }
    }
  }
`;

function assertNoUserErrors(userErrors) {
  if (userErrors.length > 0) {
    throw new Error(JSON.stringify(userErrors));
  }
}

// Shapes a cart's lines for display (title/price/image/quantity) - the same
// shape search_products returns a product in, minus availableForSale, so the
// frontend can render cart contents with the same product-card UI.
function mapCartLines(cart) {
  return cart.lines.edges.map(({ node }) => {
    const variant = node.merchandise;
    return {
      variantId: variant.id,
      title: variant.product?.title ?? variant.title,
      price: `${variant.price.amount} ${variant.price.currencyCode}`,
      quantity: node.quantity,
      imageUrl: variant.image?.url ?? null,
      imageAlt: variant.image?.altText ?? null,
    };
  });
}

// Tracks one shopper's cart entirely on the server: cartId and the
// variantId -> lineId mapping never leave this closure, so the model only
// ever deals in variantId/quantity and can't mistype or go stale on a raw
// Shopify cart or line ID.
export function createCartManager(storefrontRequest) {
  let cartId = null;
  let checkoutUrl = null;
  let cartItems = [];
  const lineIdByVariantId = new Map();

  function syncLineIds() {
    lineIdByVariantId.clear();
    for (const item of cartItems) {
      lineIdByVariantId.set(item.variantId, item.lineId);
    }
  }

  async function createCart() {
    const data = await storefrontRequest(CART_CREATE_MUTATION, {});
    assertNoUserErrors(data.cartCreate.userErrors);
    cartId = data.cartCreate.cart.id;
    checkoutUrl = data.cartCreate.cart.checkoutUrl;
  }

  async function addLine(variantId, quantity) {
    const data = await storefrontRequest(CART_LINES_ADD_MUTATION, {
      cartId,
      lines: [{ merchandiseId: variantId, quantity }],
    });
    assertNoUserErrors(data.cartLinesAdd.userErrors);
    applyCart(data.cartLinesAdd.cart);
  }

  async function updateLine(variantId, quantity) {
    const data = await storefrontRequest(CART_LINES_UPDATE_MUTATION, {
      cartId,
      lines: [{ id: lineIdByVariantId.get(variantId), quantity }],
    });
    assertNoUserErrors(data.cartLinesUpdate.userErrors);
    applyCart(data.cartLinesUpdate.cart);
  }

  async function removeLine(variantId) {
    const data = await storefrontRequest(CART_LINES_REMOVE_MUTATION, {
      cartId,
      lineIds: [lineIdByVariantId.get(variantId)],
    });
    assertNoUserErrors(data.cartLinesRemove.userErrors);
    applyCart(data.cartLinesRemove.cart);
  }

  function applyCart(cart) {
    checkoutUrl = cart.checkoutUrl;
    const lineIds = cart.lines.edges.map((edge) => edge.node.id);
    cartItems = mapCartLines(cart).map((item, i) => ({ ...item, lineId: lineIds[i] }));
    syncLineIds();
  }

  // The model only ever deals in variantId/quantity, same as everywhere else
  // in this file, so the internal lineId used to address Shopify's mutations
  // never leaves this closure.
  function publicCartItems() {
    return cartItems.map(({ lineId, ...item }) => item);
  }

  return {
    async addOrSetQuantity(variantId, quantity) {
      if (quantity === 0) {
        if (lineIdByVariantId.has(variantId)) {
          await removeLine(variantId);
        }
        return { checkoutUrl, cartItems: publicCartItems() };
      }

      if (cartId === null) {
        await createCart();
      }

      if (lineIdByVariantId.has(variantId)) {
        await updateLine(variantId, quantity);
      } else {
        await addLine(variantId, quantity);
      }

      return { checkoutUrl, cartItems: publicCartItems() };
    },

    async applyDiscountCode(code) {
      if (cartId === null) {
        throw new Error('Cart is empty - add an item before applying a discount code.');
      }
      const data = await storefrontRequest(CART_DISCOUNT_CODES_UPDATE_MUTATION, {
        cartId,
        discountCodes: [code],
      });
      assertNoUserErrors(data.cartDiscountCodesUpdate.userErrors);
      applyCart(data.cartDiscountCodesUpdate.cart);
      return { checkoutUrl, cartItems: publicCartItems() };
    },

    // Read-only snapshot of the current cart, for "what's in my cart?"
    // questions that aren't triggered by an add/update/remove.
    async getCartItems() {
      if (cartId === null) {
        return { checkoutUrl: null, cartItems: [] };
      }
      const data = await storefrontRequest(CART_QUERY, { cartId });
      if (data.cart) applyCart(data.cart);
      return { checkoutUrl, cartItems: publicCartItems() };
    },
  };
}
