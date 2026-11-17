/**
 * Custom x402 FacilitatorClient for Circle's Facilitator Service on Arc testnet.
 *
 * Why custom: Circle requires a `Facilitator-Seller-Proof` header — an EIP-712
 * signature bound to the request BODY hash and a purpose (verify/settle/status).
 * The stock HTTPFacilitatorClient's `createAuthHeaders` is called BEFORE the body
 * is built and receives no body, so it cannot sign the required bodyHash.
 *
 * The x402 protocol, the 402 challenge, and withX402 all stay standard — Circle
 * is just the settlement rail. Only verify/settle/getSupported are adapted.
 */
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";

const CIRCLE_BASE = "https://api.circle.com/v1/facilitator/x402";
const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000" as const;

const SELLER_DOMAIN = {
  name: "Circle Facilitator Seller Request",
  version: "1",
  chainId: 5042002,
} as const;

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

type ProofPurpose = "verify" | "settle" | "status" | "supported";

export type CircleFacilitatorConfig = {
  sellerPrivateKey: `0x${string}`;
  payTo: `0x${string}`;
  /** Network CAIP-2, default Arc testnet. */
  network?: string;
  /** Facilitator base URL, default Circle testnet. */
  baseUrl?: string;
  timeoutMs?: number;
};

/** Sign a seller proof for a specific purpose + exact serialized body. */
async function buildProof(
  config: Required<Pick<CircleFacilitatorConfig, "sellerPrivateKey" | "payTo">>,
  purpose: ProofPurpose,
  body: string,
): Promise<string> {
  const account = privateKeyToAccount(config.sellerPrivateKey);
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as const;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const network = NETWORK;

  const signature = await account.signTypedData({
    domain: SELLER_DOMAIN,
    types: SELLER_TYPES,
    primaryType: "SellerRequest",
    message: {
      purpose,
      method: "POST",
      bodyHash: keccak256(toBytes(body)),
      network,
      payTo: config.payTo,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });

  const envelope = { version: 1, signature, network, payTo: config.payTo, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

export class CircleFacilitator implements FacilitatorClient {
  private readonly config: CircleFacilitatorConfig;

  constructor(config: CircleFacilitatorConfig) {
    this.config = config;
  }

  /** Build the exact body string we send AND sign. */
  private buildBody(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): string {
    return JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    });
  }

  private async post(
    path: ProofPurpose,
    body: string,
  ): Promise<unknown> {
    const proof = await buildProof(this.config, path, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${this.config.baseUrl ?? CIRCLE_BASE}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Facilitator-Seller-Proof": proof,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Circle facilitator ${path} HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = this.buildBody(paymentPayload, paymentRequirements);
    const data = (await this.post("verify", body)) as Record<string, unknown>;
    return {
      isValid: data.isValid === true,
      ...(data.invalidReason ? { invalidReason: String(data.invalidReason) } : {}),
      ...(data.payer ? { payer: String(data.payer) } : {}),
    };
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const body = this.buildBody(paymentPayload, paymentRequirements);
    const data = (await this.post("settle", body)) as Record<string, unknown>;
    return {
      success: data.success === true,
      transaction: String(data.transaction ?? ""),
      network: (data.network as SettleResponse["network"]) ?? (this.config.network as SettleResponse["network"]),
      ...(data.payer ? { payer: String(data.payer) } : {}),
      ...(data.errorReason ? { errorReason: String(data.errorReason) } : {}),
      ...(data.amount ? { amount: String(data.amount) } : {}),
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    // Circle's /supported (keyless exact trial) — send a minimal signed body.
    const body = JSON.stringify({ x402Version: 2 });
    const data = (await this.post("supported", body)) as Record<string, unknown>;
    return {
      kinds: Array.isArray(data.kinds)
        ? (data.kinds as SupportedResponse["kinds"])
        : [{ x402Version: 2, scheme: "exact", network: (this.config.network ?? NETWORK) as SupportedResponse["kinds"][number]["network"], extra: { asset: USDC } }],
      extensions: Array.isArray(data.extensions) ? (data.extensions as string[]) : [],
      signers: data.signers && typeof data.signers === "object" ? (data.signers as Record<string, string[]>) : {},
    };
  }
}
