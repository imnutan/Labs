import "dotenv/config";
import { adminRequest } from "./adminclient.js";

const q = `
  query {
    products(first: 10) {
      edges {
        node {
          title
          status
        }
      }
    }
  }
`;
try {
  const data = await adminRequest(q, {});
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log("ERROR:", e.message);
}
