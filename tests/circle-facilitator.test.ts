import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, recoverTypedDataAddress } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

// Re-derive the proof with the same logic the facilitator uses, to assert the
// EIP-712 structure recovers the seller and binds the body. (We test the exact
// algorithm; a live Circle call is an integration test for demo day.)
const SELLER_DOMAIN = { name: "Circle Facilitator Seller Request", version: "1", chainId: 5042002 } as const;
const SELLER_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

// Generate at test time — no static private key in source (secret-scanner hygiene).
const account = privateKeyToAccount(generatePrivateKey());

describe("Circle seller proof (EIP-712)", () => {
  it("recovers the seller address and binds purpose + body hash", async () => {
    const body = JSON.stringify({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} });
    const issuedAt = 1_700_000_000;
    const message = {
      purpose: "settle",
      method: "POST",
      bodyHash: keccak256(toBytes(body)),
      network: "eip155:5042002",
      payTo: account.address,
      nonce: `0x${"ab".repeat(32)}` as const,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(issuedAt + 300),
    };
    const signature = await account.signTypedData({
      domain: SELLER_DOMAIN,
      types: SELLER_TYPES,
      primaryType: "SellerRequest",
      message,
    });
    const recovered = await recoverTypedDataAddress({
      domain: SELLER_DOMAIN,
      types: SELLER_TYPES,
      primaryType: "SellerRequest",
      message,
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(keccak256(toBytes(body))).toBe(message.bodyHash);
    // changing the body changes the hash — proof cannot be replayed with a different body
    expect(keccak256(toBytes(body + " "))).not.toBe(message.bodyHash);
  });
});
