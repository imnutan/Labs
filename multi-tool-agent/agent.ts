/**
 * multi-tool-agent — Claude Agent SDK lab
 *
 * An interactive REPL agent with three in-process MCP tools. Every tool has a
 * zod INPUT schema (enforced by the SDK before the handler runs) and a zod
 * OUTPUT schema (enforced by us before anything goes back to Claude).
 *
 * Run:  npm start        (Ctrl+C or /exit to quit)
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const MODEL = "claude-opus-5";
const MCP_SERVER_NAME = "store";

/* ------------------------------------------------------------------ *
 * Terminal I/O
 * ------------------------------------------------------------------ */

/** One shared readline interface: the REPL and the discount guardrail both read from it. */
const rl = createInterface({ input: stdin, output: stdout });

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  cyan: "[36m",
  yellow: "[33m",
  green: "[32m",
  red: "[31m",
  magenta: "[35m",
} as const;

function label(color: string, tag: string, body: string): void {
  console.log(`${color}${C.bold}${tag}${C.reset} ${body}`);
}

const log = {
  user: (text: string) => label(C.cyan, "[USER]", text),
  toolCall: (name: string, args: unknown) =>
    label(C.yellow, "[TOOL CALL]", `${name}(${JSON.stringify(args)})`),
  toolResult: (name: string, payload: unknown) =>
    label(C.green, "[TOOL RESULT]", `${name} -> ${JSON.stringify(payload)}`),
  toolError: (name: string, message: string) =>
    label(C.red, "[TOOL ERROR]", `${name} -> ${message}`),
  guardrail: (text: string) => label(C.magenta, "[GUARDRAIL]", text),
  claude: (text: string) => label("", "[CLAUDE]", text),
  final: (text: string) => label("", "[FINAL ANSWER]", text),
  stats: (text: string) => console.log(`${C.dim}${text}${C.reset}`),
  fatal: (text: string) => label(C.red, "[ERROR]", text),
};

/* ------------------------------------------------------------------ *
 * Tool result plumbing
 * ------------------------------------------------------------------ */

/** Structural equivalent of MCP's CallToolResult — the shape `tool()` handlers must return. */
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function toolOk(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolFailure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Validate a tool's own return value against its output schema before it is
 * forwarded to Claude. A schema miss becomes an is_error tool result — bad data
 * never reaches the model.
 */
function returnValidated<T>(
  toolName: string,
  schema: z.ZodType<T>,
  value: unknown,
): ToolResult {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const message =
      `${toolName} produced a result that failed its own output schema (${detail}). ` +
      `No data was returned — do not guess the values, tell the user the tool is broken.`;
    log.toolError(toolName, message);
    return toolFailure(message);
  }
  log.toolResult(toolName, parsed.data);
  return toolOk(parsed.data);
}

/* ------------------------------------------------------------------ *
 * Mock data
 * ------------------------------------------------------------------ */

const PRODUCT_CATALOG: Record<string, { price: number; inStock: boolean }> = {
  "wireless mouse": { price: 24.99, inStock: true },
  "mechanical keyboard": { price: 89.5, inStock: true },
  "usb-c hub": { price: 45.0, inStock: false },
  "27-inch monitor": { price: 329.99, inStock: true },
  "laptop stand": { price: 39.95, inStock: false },
};

const ORDER_BOOK: Record<string, { status: string; eta: string }> = {
  "ORD-1001": { status: "shipped", eta: "2026-08-24" },
  "ORD-1002": { status: "processing", eta: "2026-08-27" },
  "ORD-1003": { status: "delivered", eta: "2026-08-19" },
  "ORD-1004": { status: "cancelled", eta: "n/a" },
};

/** Stable pseudo-random index so unknown lookups still return consistent mock data. */
function stableIndex(key: string, buckets: number): number {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.codePointAt(0)!) % 100_000;
  }
  return hash % buckets;
}

/* ------------------------------------------------------------------ *
 * Output schemas — each tool validates its own return value
 * ------------------------------------------------------------------ */

const ProductInfoOutput = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  inStock: z.boolean(),
});

const OrderStatusOutput = z.object({
  orderId: z.string().min(1),
  status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
  eta: z.string().min(1),
});

const DiscountOutput = z.object({
  originalPrice: z.number().nonnegative(),
  percent: z.number().min(0).max(100),
  discountedPrice: z.number().nonnegative(),
});

/* ------------------------------------------------------------------ *
 * The guardrail: human confirmation before any discount is computed
 * ------------------------------------------------------------------ */

async function confirmDiscount(percent: number, price: number): Promise<boolean> {
  const question = `Apply a ${percent}% discount to $${price}? (y/n) `;
  log.guardrail(question.trim());
  const answer = await rl.question(`${C.magenta}> ${C.reset}`);
  return answer.trim() === "y";
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const getProductInfo = tool(
  "get_product_info",
  "Look up a product's current price and stock availability by product name.",
  {
    name: z.string().min(1).describe("Product name, e.g. 'wireless mouse'"),
  },
  async (args): Promise<ToolResult> => {
    const key = args.name.trim().toLowerCase();
    const known = PRODUCT_CATALOG[key];
    const mock = known ?? {
      price: Number((19.99 + stableIndex(key, 400)).toFixed(2)),
      inStock: stableIndex(key, 2) === 0,
    };

    return returnValidated("get_product_info", ProductInfoOutput, {
      name: args.name.trim(),
      price: mock.price,
      inStock: mock.inStock,
    });
  },
);

const getOrderStatus = tool(
  "get_order_status",
  "Look up the fulfilment status and estimated delivery date of an order by its order ID.",
  {
    orderId: z.string().min(1).describe("Order identifier, e.g. 'ORD-1001'"),
  },
  async (args): Promise<ToolResult> => {
    const key = args.orderId.trim().toUpperCase();
    const known = ORDER_BOOK[key];
    const statuses = ["processing", "shipped", "delivered", "cancelled"] as const;
    const mock = known ?? {
      status: statuses[stableIndex(key, statuses.length)]!,
      eta: `2026-09-${String(1 + stableIndex(key, 28)).padStart(2, "0")}`,
    };

    return returnValidated("get_order_status", OrderStatusOutput, {
      orderId: key,
      status: mock.status,
      eta: mock.eta,
    });
  },
);

const calculateDiscount = tool(
  "calculate_discount",
  "Apply a percentage discount to a price. Requires interactive human approval before it will compute anything.",
  {
    price: z.number().positive().describe("Original price in dollars"),
    percent: z.number().min(0).max(100).describe("Discount percentage, 0-100"),
  },
  async (args): Promise<ToolResult> => {
    // Guardrail runs BEFORE any computation.
    const approved = await confirmDiscount(args.percent, args.price);
    if (!approved) {
      const message =
        `The user declined to apply a ${args.percent}% discount to $${args.price}. ` +
        `No discount was calculated. Do not compute or estimate the discounted price yourself — ` +
        `report that the action was declined.`;
      log.toolError("calculate_discount", "declined by user");
      return toolFailure(message);
    }

    const discountedPrice = Number((args.price * (1 - args.percent / 100)).toFixed(2));

    return returnValidated("calculate_discount", DiscountOutput, {
      originalPrice: args.price,
      percent: args.percent,
      discountedPrice,
    });
  },
);

const storeTools = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  tools: [getProductInfo, getOrderStatus, calculateDiscount],
});

const TOOL_NAMES = [
  `mcp__${MCP_SERVER_NAME}__get_product_info`,
  `mcp__${MCP_SERVER_NAME}__get_order_status`,
  `mcp__${MCP_SERVER_NAME}__calculate_discount`,
];

/** `mcp__store__get_product_info` -> `get_product_info` for readable logs. */
function shortToolName(name: string): string {
  return name.startsWith(`mcp__${MCP_SERVER_NAME}__`)
    ? name.slice(`mcp__${MCP_SERVER_NAME}__`.length)
    : name;
}

/* ------------------------------------------------------------------ *
 * Conversation input: a queue the REPL pushes into and the SDK pulls from
 * ------------------------------------------------------------------ */

/**
 * Streaming-input mode keeps ONE session alive for the whole process, so the
 * agent sees the full conversation history on every turn. This queue lets the
 * REPL hand the next user turn to that single long-lived stream.
 */
class TurnQueue {
  #pending: string[] = [];
  #waiting: ((value: string | null) => void) | null = null;
  #closed = false;

  push(text: string): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting(text);
      return;
    }
    this.#pending.push(text);
  }

  close(): void {
    this.#closed = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting(null);
    }
  }

  next(): Promise<string | null> {
    const queued = this.#pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.#waiting = resolve;
    });
  }
}

async function* userMessages(queue: TurnQueue): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    const text = await queue.next();
    if (text === null) return;
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
  }
}

/* ------------------------------------------------------------------ *
 * Turn rendering
 * ------------------------------------------------------------------ */

/** Prints one message; returns the assistant text it printed, if any. */
function renderMessage(message: SDKMessage): string | null {
  if (message.type === "assistant") {
    let printed: string | null = null;
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim() !== "") {
        log.claude(block.text.trim());
        printed = block.text.trim();
      } else if (block.type === "tool_use") {
        log.toolCall(shortToolName(block.name), block.input);
      }
    }
    return printed;
  }
  return null;
}

/**
 * Pumps the shared stream until the current turn's `result` message arrives.
 * Returns false when the stream is exhausted (the session ended).
 */
async function runTurn(
  stream: AsyncIterator<SDKMessage, void>,
): Promise<boolean> {
  let lastAssistantText: string | null = null;

  for (;;) {
    const next = await stream.next();
    if (next.done === true) return false;

    const message = next.value;
    const printed = renderMessage(message);
    if (printed !== null) lastAssistantText = printed;

    if (message.type !== "result") continue;

    if (message.subtype === "success") {
      // Only reprint if the final text wasn't already shown as an assistant block.
      if (message.result.trim() !== lastAssistantText) {
        log.final(message.result.trim());
      }
      log.stats(
        `— ${message.num_turns} model turn(s) · ${message.duration_ms} ms · ` +
          `$${message.total_cost_usd.toFixed(4)}`,
      );
    } else {
      log.fatal(`turn ended: ${message.subtype}`);
    }
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * REPL
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are a store assistant for an online electronics shop.

You have exactly three tools: get_product_info, get_order_status and calculate_discount.
Rules:
- Always use a tool to obtain product prices, stock, order status or discounted prices. Never invent or estimate these values.
- calculate_discount requires human approval. If it returns an error saying the user declined, say plainly that the discount was not applied and do not compute it yourself.
- If a tool returns an error, report the problem instead of guessing.
- Resolve follow-up references ("that order", "the same product", "what about 20% off?") from earlier turns in this conversation.
- Keep answers short and concrete.`;

const options = {
  model: MODEL,
  systemPrompt: SYSTEM_PROMPT,
  mcpServers: { [MCP_SERVER_NAME]: storeTools },
  // Only the three lab tools: no built-ins, and the three MCP tools pre-approved.
  tools: [],
  allowedTools: TOOL_NAMES,
  settingSources: [],
} satisfies Options;

async function main(): Promise<void> {
  if (process.env["ANTHROPIC_API_KEY"] === undefined) {
    log.fatal("ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).");
    rl.close();
    process.exitCode = 1;
    return;
  }

  console.log(`${C.bold}multi-tool-agent${C.reset} ${C.dim}(${MODEL})${C.reset}`);
  console.log(
    `${C.dim}Tools: ${TOOL_NAMES.map(shortToolName).join(", ")}` +
      `\nConversation history is kept across turns. Type /exit to quit.${C.reset}`,
  );

  const queue = new TurnQueue();
  const conversation = query({ prompt: userMessages(queue), options });
  const stream = conversation[Symbol.asyncIterator]();

  try {
    for (;;) {
      const input = (await rl.question(`\n${C.cyan}you > ${C.reset}`)).trim();
      if (input === "") continue;
      if (input === "/exit" || input === "/quit") break;

      console.log("");
      log.user(input);
      queue.push(input);

      const alive = await runTurn(stream);
      if (!alive) {
        log.fatal("the agent session ended unexpectedly.");
        break;
      }
    }
  } finally {
    queue.close();
    conversation.close();
    rl.close();
  }
}

rl.on("close", () => {
  // Ctrl+C / Ctrl+D at the prompt.
  process.exitCode = 0;
});

await main();
