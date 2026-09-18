import {
    McpServer
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
    z
} from "zod";
import {
    storefrontRequest
} from "./storefrontclient.js";

function buildServer() {
    const server = new McpServer({
        name: "shopify-tools",
        version: "1.0.0"
    });
    server.registerTool("search_products", {
        title: "Search Products",
        description: "Search the store catalog for products matching a text query.",
        inputSchema: {
            query: z.string().default("")
        },
    }, async ({
        query
    }) => {
        const data = await storefrontRequest(` query($query: String) { products(first: 5, query: $query) { edges { node { title priceRange { minVariantPrice { amount currencyCode } } variants(first: 1) { edges { node { id } } } } } } } `, {
            query
        });
        const products = data.products.edges.map((e) => ({
            title: e.node.title,
            price: e.node.priceRange.minVariantPrice.amount,
            currency: e.node.priceRange.minVariantPrice.currencyCode,
            variantId: e.node.variants.edges[0]?.node.id ?? "",
        }));
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    products
                })
            }]
        };
    });
    return server;
}
const app = express();
app.use(express.json());
// Stateless mode: a fresh server + transport per request. Simple, and enough
// for tools with no cross-call session state (Module 5's cart tool needs a
// session id of its own if you bring it into this same server).

app.post("/mcp", async (req, res) => { 
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); 
  const server = buildServer(); 
  await server.connect(transport); 
  await transport.handleRequest(req, res, req.body); 
  res.on("close", () => { transport.close(); server.close(); });});
app.listen(3200, () => console.log("MCP server listening on :3200/mcp"));