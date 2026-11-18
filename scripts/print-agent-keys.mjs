/**
 * Print the eight demo agent wallets (letter, address, private key) to the
 * terminal so they can be imported into MetaMask. Reads ONLY .env.local —
 * no key material is stored or committed anywhere here.
 *
 * Testnet keys, but treat them as hot demo keys: never commit, never share.
 *
 * Run: node scripts/print-agent-keys.mjs
 */
import { readFileSync } from "node:fs";

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const LABELS = {
  "0x04d9fd5dc9da8c827daa0c110d6c1637f0a7c207": "A",
  "0x47e9fdd71b7e54e26079b98b15ed9a872af42991": "B",
  "0x4c7d8c17bd6a94e6a8daa38e3032b4574934d781": "C",
  "0x982eac5ba25c78c732bbb24e6f191f9fab3aa1f5": "D",
  "0xd46b1fd5802624261bd392cc13a8c08b72ce8265": "E",
  "0xee8be78309e44bd5e07bebcd7e213ecbc3e6be6e": "F",
  "0x344cb12f2f20e4593fa139a7f87e4e4595bf4ad0": "G",
  "0x701c332e43e1d6f646054b793cc3870916e0f1fc": "H",
};

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const line = env.split("\n").find((l) => l.startsWith("AGENT_KEYS="));
if (!line) {
  console.error("AGENT_KEYS not found in .env.local");
  process.exit(1);
}
const keys = JSON.parse(line.slice("AGENT_KEYS=".length));

let i = 0;
for (const [id, key] of Object.entries(keys)) {
  const label = LABELS[id.toLowerCase()] ?? LETTERS[i] ?? "?";
  console.log(`${label}  ${id}  ${key}`);
  i++;
}
console.log("\nImport into MetaMask: Accounts → Import account → Private key (one per wallet).");
console.log("Then add the Arc Testnet network: RPC https://rpc.testnet.arc.io · chain id 5042002 · currency symbol USDC.");
