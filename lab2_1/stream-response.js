import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  fail(
    "ANTHROPIC_API_KEY is not set.\n" +
      "Create a .env file next to this script containing:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
}

const client = new Anthropic();

try {
  const stream = client.messages.stream({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    // Thinking off so text starts arriving immediately instead of after a
    // silent reasoning pause — and so the 1024 budget all goes to the copy.
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content:
          "Write a short, upbeat product description for an insulated water bottle.",
      },
    ],
  });

  // The `text` event carries just the delta string. process.stdout.write is
  // unbuffered on a TTY, so chunks appear as they arrive.
  stream.on("text", (delta) => {
    process.stdout.write(delta);
  });

  const message = await stream.finalMessage();

  process.stdout.write("\n");
  console.log(
    `Usage: input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens}`,
  );
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    fail("ANTHROPIC_API_KEY was rejected by the API — check the key value.");
  } else if (error instanceof Anthropic.RateLimitError) {
    fail("Rate limited by the API. Wait a moment and try again.");
  } else if (error instanceof Anthropic.APIError) {
    fail(`API error ${error.status}: ${error.message}`);
  } else {
    fail(error instanceof Error ? error.message : String(error));
  }
}
