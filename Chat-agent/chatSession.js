import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A single-value-at-a-time async channel. push() hands the value straight to
// a reader that's already awaiting next(); otherwise it buffers the value
// until a reader asks. Readers and writers never touch a shared mutable slot
// directly, so a fast push() right after a previous one can never race a
// pending next() and clobber it before it's read.
class MessageQueue {
  constructor() {
    this._buffered = [];
    this._waiting = [];
  }

  push(value) {
    if (this._waiting.length > 0) {
      const resolve = this._waiting.shift();
      resolve(value);
    } else {
      this._buffered.push(value);
    }
  }

  next() {
    if (this._buffered.length > 0) {
      return Promise.resolve(this._buffered.shift());
    }
    return new Promise((resolve) => this._waiting.push(resolve));
  }
}

export class ChatSession {
  constructor({ mcpServers, allowedTools, systemPrompt } = {}) {
    this.lastActiveAt = Date.now();
    this._queue = new MessageQueue();
    this._pending = null;
    // Resolves/rejects to a no-op-on-error promise so one failed turn never
    // wedges every later send() for this shopper.
    this._sendChain = Promise.resolve();
    // A fresh, throwaway CLAUDE_CONFIG_DIR per shopper, so one shopper's
    // on-disk session state can never be reached from another's.
    this._configDir = mkdtempSync(join(tmpdir(), 'chat-session-'));

    this._stream = query({
      prompt: this._userMessages(),
      options: {
        mcpServers,
        allowedTools,
        systemPrompt,
        // This is a headless backend, not an interactive Claude Code
        // session: drop the built-in coding tools (Bash, Edit, Write, ...)
        // and stop the query from picking up this host's own ambient
        // ~/.claude settings or .mcp.json - a shopper should only ever
        // reach the MCP tools this session was explicitly wired with.
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        env: { ...process.env, CLAUDE_CONFIG_DIR: this._configDir },
        // --bare pins auth to strictly ANTHROPIC_API_KEY (OAuth and the
        // keychain are never read) and turns off hooks/auto-memory/plugin
        // sync too. Without it, the subprocess falls back to whatever
        // personal `claude login` session happens to exist on the host -
        // which is how an earlier version of this backend ended up
        // authenticating as, and knowing the email of, the developer who
        // was logged in, and volunteering it to a shopper who never gave
        // one. This is what actually forces the store's own key to be used
        // instead; the CLAUDE_CONFIG_DIR isolation above is belt-and-braces
        // on top of it.
        extraArgs: { bare: null },
      },
    });

    this._consumed = this._consume();
  }

  async *_userMessages() {
    while (true) {
      yield await this._queue.next();
    }
  }

  async _consume() {
    let assistantText = '';
    // A turn commonly calls search_products more than once with different
    // queries (retrying after an empty result, checking a few categories),
    // so results are merged and de-duped by variantId across the whole turn
    // rather than the last call's results clobbering an earlier good one.
    let productsByVariantId = new Map();
    // update_cart/apply_discount_code/get_cart all return the cart's full
    // current contents (not a partial delta), so the latest call this turn
    // is simply the answer - no merging needed like products above. null
    // means no cart tool ran this turn, distinct from an intentionally empty
    // cart ([]).
    let cartSnapshot = null;
    // Maps a tool_use block's id to its tool name so that when the matching
    // tool_result arrives (a separate 'user' message later in the stream)
    // we know which tool produced it - tool_use and tool_result are never in
    // the same message.
    const toolNameById = new Map();

    for await (const message of this._stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') assistantText += block.text;
          else if (block.type === 'tool_use') toolNameById.set(block.id, block.name);
        }
      } else if (message.type === 'user' && message.tool_use_result) {
        const toolUseId = message.message.content?.find?.((block) => block.type === 'tool_result')?.tool_use_id;
        const toolName = toolUseId ? toolNameById.get(toolUseId) : undefined;
        const text = message.tool_use_result?.[0]?.text;
        if (toolName?.endsWith('__search_products')) {
          try {
            const parsed = text && JSON.parse(text);
            if (Array.isArray(parsed)) {
              for (const product of parsed) {
                if (product.variantId) productsByVariantId.set(product.variantId, product);
              }
            }
          } catch {
            // Malformed or error-shaped tool output - just don't surface products for this turn.
          }
        } else if (
          toolName?.endsWith('__update_cart') ||
          toolName?.endsWith('__apply_discount_code') ||
          toolName?.endsWith('__get_cart')
        ) {
          try {
            const parsed = text && JSON.parse(text);
            if (parsed && Array.isArray(parsed.cartItems)) {
              cartSnapshot = { checkoutUrl: parsed.checkoutUrl ?? null, cartItems: parsed.cartItems };
            }
          } catch {
            // Malformed or error-shaped tool output - just don't surface cart contents for this turn.
          }
        }
      } else if (message.type === 'result') {
        const pending = this._pending;
        this._pending = null;
        const text = assistantText;
        const turnProducts = [...productsByVariantId.values()];
        const turnCart = cartSnapshot;
        assistantText = '';
        productsByVariantId = new Map();
        cartSnapshot = null;
        toolNameById.clear();
        if (!pending) continue;
        if (message.subtype === 'success') {
          pending.resolve({
            text: message.result ?? text,
            products: turnProducts,
            cartItems: turnCart?.cartItems ?? null,
            checkoutUrl: turnCart?.checkoutUrl ?? null,
          });
        } else {
          pending.reject(new Error(message.errors?.join('; ') || `agent turn failed: ${message.subtype}`));
        }
      }
    }
  }

  // Pushes text onto the queue and returns a promise for that turn's full
  // reply. Chained onto the previous send()'s settlement so a second message
  // fired before the first replies waits its turn instead of racing it -
  // its content only reaches the queue once the prior turn's result has
  // resolved this._pending, so replies can never come back swapped.
  send(text) {
    this.lastActiveAt = Date.now();
    const turn = this._sendChain.then(() => this._sendOne(text));
    this._sendChain = turn.catch(() => {});
    return turn;
  }

  _sendOne(text) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
    });
  }

  async close() {
    try {
      await this._stream.return();
    } catch {
      // best-effort teardown
    }
    try {
      rmSync(this._configDir, { recursive: true, force: true });
    } catch {
      // best-effort teardown
    }
  }
}
