import { useEffect, useRef, useState } from 'react';
import './ChatWidget.css';

const SESSION_STORAGE_KEY = 'shopify-chat-session-id';

function generateUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for contexts without crypto.randomUUID (e.g. non-HTTPS).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// The session ID is the only thing linking this browser tab to a specific
// ChatSession and cart on the backend, so it's read from localStorage before
// ever generating a new one - a shopper who reloads or comes back later
// keeps the same session and cart instead of starting over.
function getOrCreateSessionId() {
  let sessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId) {
    sessionId = generateUuid();
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }
  return sessionId;
}

let nextMessageId = 0;
function createMessage(role, text, extra) {
  nextMessageId += 1;
  return {
    id: nextMessageId,
    role,
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ...extra,
  };
}

function ChatBubbleIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-4.5 7.4 8.5 8.5 0 0 1-8.9-.5L3 21l1.9-4.6a8.38 8.38 0 0 1-1.4-4.7 8.5 8.5 0 0 1 8.5-8.5h.5a8.48 8.48 0 0 1 8 8v.3z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function QuantityStepper({ quantity, onDecrease, onIncrease, decreaseDisabled, disabled }) {
  return (
    <div className="chat-widget__qty-stepper">
      <button
        className="chat-widget__qty-btn"
        type="button"
        onClick={onDecrease}
        disabled={disabled || decreaseDisabled}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <span className="chat-widget__qty-value">{quantity}</span>
      <button
        className="chat-widget__qty-btn"
        type="button"
        onClick={onIncrease}
        disabled={disabled}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

function ProductCard({ product, onAddToCart, disabled }) {
  const [quantity, setQuantity] = useState(1);
  const canAdd = !disabled && product.availableForSale && Boolean(product.variantId);

  function handleAdd() {
    onAddToCart(product, quantity);
    setQuantity(1);
  }

  return (
    <div className="chat-widget__product-card">
      <div className="chat-widget__product-image-wrap">
        {product.imageUrl ? (
          <img
            className="chat-widget__product-image"
            src={product.imageUrl}
            alt={product.imageAlt || product.title}
          />
        ) : (
          <div className="chat-widget__product-image-placeholder" aria-hidden="true">
            🛍️
          </div>
        )}
        {!product.availableForSale && <span className="chat-widget__product-badge">Sold out</span>}
      </div>
      <div className="chat-widget__product-body">
        <p className="chat-widget__product-title">{product.title}</p>
        <p className="chat-widget__product-price">{product.price}</p>
        {product.availableForSale && (
          <QuantityStepper
            quantity={quantity}
            onDecrease={() => setQuantity((q) => Math.max(1, q - 1))}
            onIncrease={() => setQuantity((q) => Math.min(99, q + 1))}
            decreaseDisabled={quantity <= 1}
            disabled={disabled}
          />
        )}
        <button className="chat-widget__product-add" type="button" onClick={handleAdd} disabled={!canAdd}>
          <CartIcon />
          {product.availableForSale ? 'Add to cart' : 'Sold out'}
        </button>
      </div>
    </div>
  );
}

function CartItemCard({ item, onUpdateQuantity, onRemove, disabled }) {
  return (
    <div className="chat-widget__product-card">
      <div className="chat-widget__product-image-wrap">
        {item.imageUrl ? (
          <img className="chat-widget__product-image" src={item.imageUrl} alt={item.imageAlt || item.title} />
        ) : (
          <div className="chat-widget__product-image-placeholder" aria-hidden="true">
            🛍️
          </div>
        )}
      </div>
      <div className="chat-widget__product-body">
        <p className="chat-widget__product-title">{item.title}</p>
        <p className="chat-widget__product-price">{item.price}</p>
        <QuantityStepper
          quantity={item.quantity}
          onDecrease={() => onUpdateQuantity(item, item.quantity - 1)}
          onIncrease={() => onUpdateQuantity(item, item.quantity + 1)}
          decreaseDisabled={item.quantity <= 1}
          disabled={disabled}
        />
        <button
          className="chat-widget__product-remove"
          type="button"
          onClick={() => onRemove(item)}
          disabled={disabled}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionId] = useState(getOrCreateSessionId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pendingCount, isOpen]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // displayText lets an "Add to cart" click show a short shopper bubble
  // while the backend still gets an unambiguous instruction that names the
  // exact variantId - the agent already saw that variant in its own
  // search_products call, but pinning it here removes any doubt.
  async function sendMessage(sendText, displayText = sendText) {
    setMessages((prev) => [...prev, createMessage('shopper', displayText)]);
    setPendingCount((count) => count + 1);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: sendText }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Request failed with status ${res.status}`);
      const extra = {};
      if (body.products?.length) extra.products = body.products;
      // cartItems is null when no cart tool ran this turn, vs. [] for an
      // intentionally empty cart - only the array case should render.
      if (Array.isArray(body.cartItems)) {
        extra.cartItems = body.cartItems;
        extra.checkoutUrl = body.checkoutUrl ?? null;
      }
      setMessages((prev) => [
        ...prev,
        createMessage('agent', body.reply, Object.keys(extra).length ? extra : undefined),
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        createMessage('error', "Sorry, that message didn't go through. Please try again."),
      ]);
    } finally {
      setPendingCount((count) => count - 1);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    sendMessage(text);
  }

  // Only wipes what's on screen - the backend session, the agent's memory
  // of the conversation, and the shopper's cart are untouched, since the
  // session ID is also what the cart is keyed on.
  function handleClearChat() {
    setMessages([]);
  }

  function handleAddToCart(product, quantity = 1) {
    sendMessage(
      `Add "${product.title}" (variant ${product.variantId}) to my cart, quantity ${quantity}.`,
      quantity === 1 ? `Add "${product.title}" to cart` : `Add ${quantity} × "${product.title}" to cart`
    );
  }

  function handleUpdateCartQuantity(item, quantity) {
    sendMessage(
      `Update "${item.title}" (variant ${item.variantId}) in my cart to quantity ${quantity}.`,
      `Update "${item.title}" to ${quantity} in cart`
    );
  }

  function handleRemoveFromCart(item) {
    sendMessage(
      `Remove "${item.title}" (variant ${item.variantId}) from my cart.`,
      `Remove "${item.title}" from cart`
    );
  }

  return (
    <div className="chat-widget-root">
      {isOpen && (
        <div className="chat-widget" role="dialog" aria-label="Store assistant chat">
          <header className="chat-widget__header">
            <div className="chat-widget__header-info">
              <span className="chat-widget__avatar" aria-hidden="true">🛍️</span>
              <div>
                <p className="chat-widget__title">Store Assistant</p>
                <p className="chat-widget__status">
                  <span className="chat-widget__status-dot" /> Online
                </p>
              </div>
            </div>
            <div className="chat-widget__header-actions">
              <button
                className="chat-widget__header-action"
                type="button"
                onClick={handleClearChat}
                disabled={messages.length === 0}
                aria-label="Clear chat"
                title="Clear chat"
              >
                <TrashIcon />
              </button>
              <button
                className="chat-widget__header-action"
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close chat"
                title="Close chat"
              >
                <CloseIcon />
              </button>
            </div>
          </header>

          <div className="chat-widget__messages">
            {messages.length === 0 && pendingCount === 0 && (
              <div className="chat-widget__welcome">
                👋 Hi there! Ask me about products, your cart, or an order you've already placed.
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className={`chat-widget__message chat-widget__message--${message.role}`}>
                <p className="chat-widget__message-text">{message.text}</p>
                {message.products?.length > 0 && (
                  <div className="chat-widget__products">
                    {message.products.map((product) => (
                      <ProductCard
                        key={product.variantId || product.title}
                        product={product}
                        onAddToCart={handleAddToCart}
                        disabled={pendingCount > 0}
                      />
                    ))}
                  </div>
                )}
                {message.cartItems && (
                  <div className="chat-widget__cart">
                    {message.cartItems.length === 0 ? (
                      <p className="chat-widget__cart-empty">Your cart is empty.</p>
                    ) : (
                      <>
                        <div className="chat-widget__products">
                          {message.cartItems.map((item) => (
                            <CartItemCard
                              key={item.variantId}
                              item={item}
                              onUpdateQuantity={handleUpdateCartQuantity}
                              onRemove={handleRemoveFromCart}
                              disabled={pendingCount > 0}
                            />
                          ))}
                        </div>
                        {message.checkoutUrl && (
                          <a
                            className="chat-widget__checkout-link"
                            href={message.checkoutUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Go to checkout
                          </a>
                        )}
                      </>
                    )}
                  </div>
                )}
                <span className="chat-widget__message-time">{message.time}</span>
              </div>
            ))}

            {pendingCount > 0 && (
              <div className="chat-widget__message chat-widget__message--agent" aria-live="polite" aria-label="Agent is typing">
                <span className="chat-widget__typing-bubble">
                  <span className="chat-widget__typing-dot" />
                  <span className="chat-widget__typing-dot" />
                  <span className="chat-widget__typing-dot" />
                </span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <form className="chat-widget__form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              className="chat-widget__input"
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type a message..."
              aria-label="Message"
            />
            <button className="chat-widget__send" type="submit" disabled={!input.trim()} aria-label="Send message">
              <SendIcon />
            </button>
          </form>
        </div>
      )}

      <button
        className="chat-widget__launcher"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
      >
        {isOpen ? <CloseIcon /> : <ChatBubbleIcon />}
      </button>
    </div>
  );
}
