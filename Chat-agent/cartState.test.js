import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCartManager } from './cartState.js';

// A tiny in-memory stand-in for the real Storefront API: routes each
// mutation string to the right handler and keeps its own cart/line state so
// assertions can check what the manager actually persisted, not just what it
// returned.
function createMockStorefront() {
  let nextCartId = 1;
  let nextLineId = 1;
  const calls = {
    cartCreate: 0,
    cartLinesAdd: 0,
    cartLinesUpdate: 0,
    cartLinesRemove: 0,
    cartDiscountCodesUpdate: 0,
    getCart: 0,
  };
  let cart = null;

  function merchandiseFor(variantId) {
    return {
      id: variantId,
      title: 'Default Title',
      price: { amount: '10.00', currencyCode: 'USD' },
      image: null,
      product: { title: `Product ${variantId}` },
    };
  }

  function linesPayload() {
    return {
      edges: [...cart.lines.entries()].map(([id, line]) => ({
        node: { id, quantity: line.quantity, merchandise: merchandiseFor(line.variantId) },
      })),
    };
  }

  async function storefrontRequest(query, variables) {
    if (query.includes('mutation CartCreate')) {
      calls.cartCreate++;
      const id = `gid://shopify/Cart/${nextCartId++}`;
      cart = { id, checkoutUrl: `https://example.myshopify.com/checkout/${id}`, lines: new Map() };
      return { cartCreate: { cart: { id: cart.id, checkoutUrl: cart.checkoutUrl }, userErrors: [] } };
    }

    if (query.includes('mutation CartLinesAdd')) {
      calls.cartLinesAdd++;
      for (const line of variables.lines) {
        const lineId = `gid://shopify/CartLine/${nextLineId++}`;
        cart.lines.set(lineId, { variantId: line.merchandiseId, quantity: line.quantity });
      }
      return {
        cartLinesAdd: {
          cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() },
          userErrors: [],
        },
      };
    }

    if (query.includes('mutation CartLinesUpdate')) {
      calls.cartLinesUpdate++;
      for (const line of variables.lines) {
        cart.lines.get(line.id).quantity = line.quantity;
      }
      return {
        cartLinesUpdate: {
          cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() },
          userErrors: [],
        },
      };
    }

    if (query.includes('mutation CartLinesRemove')) {
      calls.cartLinesRemove++;
      for (const lineId of variables.lineIds) {
        cart.lines.delete(lineId);
      }
      return {
        cartLinesRemove: {
          cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() },
          userErrors: [],
        },
      };
    }

    if (query.includes('mutation CartDiscountCodesUpdate')) {
      calls.cartDiscountCodesUpdate++;
      if (variables.discountCodes.includes('INVALID')) {
        return {
          cartDiscountCodesUpdate: {
            cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() },
            userErrors: [{ field: ['discountCodes'], message: 'Discount code not found.' }],
          },
        };
      }
      return {
        cartDiscountCodesUpdate: {
          cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() },
          userErrors: [],
        },
      };
    }

    if (query.includes('query GetCart')) {
      calls.getCart++;
      if (!cart || cart.id !== variables.cartId) {
        return { cart: null };
      }
      return { cart: { id: cart.id, checkoutUrl: cart.checkoutUrl, lines: linesPayload() } };
    }

    throw new Error(`mock storefront received an unexpected mutation: ${query}`);
  }

  return { storefrontRequest, calls, getCart: () => cart };
}

test('creates the cart only once across two different variants', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  await manager.addOrSetQuantity('variant-2', 2);

  assert.equal(mock.calls.cartCreate, 1);
  assert.equal(mock.calls.cartLinesAdd, 2);
  assert.equal(mock.getCart().lines.size, 2);
});

test('a second call for an already-added variant updates its line instead of duplicating it', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  await manager.addOrSetQuantity('variant-1', 5);

  assert.equal(mock.calls.cartLinesAdd, 1);
  assert.equal(mock.calls.cartLinesUpdate, 1);
  assert.equal(mock.getCart().lines.size, 1);
  const [line] = mock.getCart().lines.values();
  assert.equal(line.quantity, 5);
});

test('quantity 0 removes a tracked line', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  const result = await manager.addOrSetQuantity('variant-1', 0);

  assert.equal(mock.calls.cartLinesRemove, 1);
  assert.equal(mock.getCart().lines.size, 0);
  assert.equal(result.checkoutUrl, mock.getCart().checkoutUrl);
  assert.deepEqual(result.cartItems, []);
});

test('quantity 0 for a variant that was never added is a safe no-op', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  const result = await manager.addOrSetQuantity('variant-never-added', 0);

  assert.equal(mock.calls.cartCreate, 0);
  assert.equal(mock.calls.cartLinesAdd, 0);
  assert.equal(mock.calls.cartLinesRemove, 0);
  assert.equal(result.checkoutUrl, null);
  assert.deepEqual(result.cartItems, []);
});

test('removing one line never disturbs any other line in the same cart', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  await manager.addOrSetQuantity('variant-2', 3);
  await manager.addOrSetQuantity('variant-1', 0);

  const remaining = [...mock.getCart().lines.values()];
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0], { variantId: 'variant-2', quantity: 3 });

  // variant-1 is no longer tracked, so removing it again must not touch the cart.
  const result = await manager.addOrSetQuantity('variant-1', 0);
  assert.equal(mock.calls.cartLinesRemove, 1);
  assert.equal(mock.getCart().lines.size, 1);
  assert.equal(result.checkoutUrl, mock.getCart().checkoutUrl);
});

test('addOrSetQuantity returns display-ready cart items without leaking the internal line ID', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  const result = await manager.addOrSetQuantity('variant-1', 2);

  assert.equal(result.cartItems.length, 1);
  assert.deepEqual(result.cartItems[0], {
    variantId: 'variant-1',
    title: 'Product variant-1',
    price: '10.00 USD',
    quantity: 2,
    imageUrl: null,
    imageAlt: null,
  });
  assert.equal('lineId' in result.cartItems[0], false);
});

test('getCartItems on an empty cart never calls the API', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  const result = await manager.getCartItems();

  assert.equal(mock.calls.getCart, 0);
  assert.deepEqual(result, { checkoutUrl: null, cartItems: [] });
});

test('getCartItems reflects items added earlier in the session', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  await manager.addOrSetQuantity('variant-2', 3);
  const result = await manager.getCartItems();

  assert.equal(mock.calls.getCart, 1);
  assert.equal(result.cartItems.length, 2);
  assert.equal(result.checkoutUrl, mock.getCart().checkoutUrl);
});

test('applying a discount code before any item exists is rejected without calling the API', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await assert.rejects(() => manager.applyDiscountCode('SAVE10'), /Cart is empty/);
  assert.equal(mock.calls.cartDiscountCodesUpdate, 0);
});

test('applying a valid discount code to an existing cart returns the updated checkout URL', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  const result = await manager.applyDiscountCode('SAVE10');

  assert.equal(mock.calls.cartDiscountCodesUpdate, 1);
  assert.equal(result.checkoutUrl, mock.getCart().checkoutUrl);
});

test('an invalid discount code surfaces the Storefront userError instead of a checkout URL', async () => {
  const mock = createMockStorefront();
  const manager = createCartManager(mock.storefrontRequest);

  await manager.addOrSetQuantity('variant-1', 1);
  await assert.rejects(() => manager.applyDiscountCode('INVALID'), /Discount code not found/);
});
