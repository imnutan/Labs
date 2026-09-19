import "dotenv/config";
import { storefrontRequest } from "./Storefrontclient.js";

const q = `
  query {
    products(first: 10) {
      edges { node { title onlineStoreUrl availableForSale } }
    }
  }
`;
try {
  const data = await storefrontRequest(q, {});
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log("ERROR:", e.message);
}
