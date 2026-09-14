require("dotenv").config();

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;

const API_VERSION = "2026-07";

for (const [name, value] of Object.entries({
  SHOPIFY_STORE_DOMAIN: domain,
  SHOPIFY_APP_CLIENT_ID: clientId,
  SHOPIFY_APP_CLIENT_SECRET: clientSecret,
})) {
  if (!value) throw new Error(`Missing ${name} in .env`);
}

let cachedToken = null,
  cachedTokenExpiresAt = 0;

// Shopify returns an HTML error page for OAuth failures (app_not_installed,
// invalid_request, ...), so read as text first and only then parse as JSON.
async function readBody(res, what) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const title = text.match(/<title>([^<]*)<\/title>/);
    throw new Error(
      `${what} failed: HTTP ${res.status} ${res.statusText}` +
        (title ? ` - ${title[1].trim()}` : ` - ${text.slice(0, 200)}`)
    );
  }
}

async function getAdminAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  const data = await readBody(res, "Token exchange");
  if (!data.access_token) throw new Error("Token exchange failed: " + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function adminRequest(query, variables) {
  const token = await getAdminAccessToken();
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await readBody(res, "Admin API request");
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

module.exports = { adminRequest };
