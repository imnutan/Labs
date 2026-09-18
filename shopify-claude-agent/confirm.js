import readline from "node:readline/promises";
export const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
export async function askConfirmation(question) { 
const answer = await rl.question(question); 
return answer.trim().toLowerCase() === "y";
}