# multi-tool-agent

An interactive Claude Agent SDK agent with three in-process MCP tools, zod validation on
both sides of every tool, and a human-approval guardrail on the one tool that changes a
number the user cares about.

## Run

```bash
cp .env.example .env     # then paste your ANTHROPIC_API_KEY
npm install
npm start                # /exit or Ctrl+C to quit
```

`npm start` is `node agent.ts` — Node 23.6+ strips the types natively, no build step.
`npm run typecheck` runs `tsc --noEmit`; `npm run build` emits to `dist/`.

## What's in [agent.ts](agent.ts)

| Piece | Where |
|---|---|
| `.env` → `process.env` via dotenv | top-of-file `import "dotenv/config"` |
| Three tools on one `createSdkMcpServer` | `storeTools` |
| zod **input** schemas | 3rd argument of each `tool(...)` call — the SDK rejects bad input before the handler runs |
| zod **output** schemas | `ProductInfoOutput` / `OrderStatusOutput` / `DiscountOutput`, enforced by `returnValidated()` |
| Human-approval guardrail | `confirmDiscount()`, called first thing inside `calculate_discount` |
| Full conversation history | `TurnQueue` + `userMessages()` streaming-input generator |
| Labelled turn output | the `log` object + `renderMessage()` |

### The tools

| Tool | Input | Output |
|---|---|---|
| `get_product_info` | `name: string` | `{ name, price, inStock }` |
| `get_order_status` | `orderId: string` | `{ orderId, status, eta }` |
| `calculate_discount` | `price: number`, `percent: number` | `{ originalPrice, percent, discountedPrice }` |

Product and order data are mocked. Known keys (`wireless mouse`, `ORD-1002`, …) come from
the tables at the top of the file; anything else gets a stable hash-derived mock so repeat
lookups of the same name stay consistent.

### The guardrail

`calculate_discount` prints `Apply a {percent}% discount to ${price}? (y/n)` and reads the
next line **before computing anything**. Only a literal `y` produces a discounted price;
anything else returns an `is_error` tool result telling Claude the action was declined and
not to compute the number itself.

```
[TOOL CALL] calculate_discount({"price":89.5,"percent":25})
[GUARDRAIL] Apply a 25% discount to $89.5? (y/n)
> n
[TOOL ERROR] calculate_discount -> declined by user
[CLAUDE] The 25% discount was not applied — the request was declined, so I can't give you a discounted price.
```

The REPL and the guardrail share one `readline` interface, so the confirmation reads from
the same terminal the user is already typing into.

### Output validation

`returnValidated()` runs the tool's own return value through its zod output schema. On a
miss it logs `[TOOL ERROR]` and returns `isError: true` with the failing paths — malformed
data never reaches the model. To see it fire, break a schema on purpose, e.g. change
`discountedPrice` to `z.string()` in `DiscountOutput`.

### Conversation memory

The agent runs in streaming-input mode: one `query()` call for the life of the process,
fed by an async generator. That keeps a single session, so the full history is on the wire
every turn and follow-ups resolve against it:

```
you > How much is a wireless mouse?
[CLAUDE] The wireless mouse is $24.99 and it's in stock.

you > apply a 10% discount to that price
[TOOL CALL] calculate_discount({"price":24.99,"percent":10})   ← "that price" resolved from turn 1
```

### Tool surface

All Claude Code built-ins are off (`tools: []`) and only the three MCP tools are allowed:

```ts
allowedTools: [
  "mcp__store__get_product_info",
  "mcp__store__get_order_status",
  "mcp__store__calculate_discount",
]
```

Listing them in `allowedTools` also pre-approves them, so the SDK's own permission prompt
stays out of the way of the lab's guardrail.
