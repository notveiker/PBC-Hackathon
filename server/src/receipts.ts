import { exportJWK, SignJWT, jwtVerify } from "jose";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

const RECEIPT_ISSUER = "tron-commerce-gateway";
const RECEIPT_AUDIENCE = "agent-client";
const RECEIPT_ALG = "ES256";

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function loadReceiptKeys(): {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  source: "env" | "generated";
} {
  const privatePem = process.env.RECEIPT_PRIVATE_KEY_PEM?.trim();
  const publicPem = process.env.RECEIPT_PUBLIC_KEY_PEM?.trim();

  if (privatePem && publicPem) {
    const normalizedPrivate = normalizePem(privatePem);
    const normalizedPublic = normalizePem(publicPem);
    return {
      privateKey: createPrivateKey(normalizedPrivate),
      publicKey: createPublicKey(normalizedPublic),
      publicKeyPem: normalizedPublic,
      source: "env",
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { privateKey, publicKey, publicKeyPem, source: "generated" };
}

const receiptKeys = loadReceiptKeys();
let publicJwkPromise:
  | Promise<Record<string, unknown>>
  | null = null;

export type ReceiptClaims = {
  txId: string;
  nonce: string;
  resource: string;
  merchant: string;
  payer: string;
  chain: string;
  asset: "TRX" | "USDT";
};

export async function issueSignedPayload(
  subject: string,
  payload: Record<string, unknown>,
  expiresIn: string = "7d"
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: RECEIPT_ALG, kid: "merchant-receipt-key" })
    .setIssuer(RECEIPT_ISSUER)
    .setAudience(RECEIPT_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(receiptKeys.privateKey);
}

export async function issueReceiptJwt(
  claims: ReceiptClaims,
  ttlSec: number
): Promise<string> {
  return new SignJWT({
    txId: claims.txId,
    nonce: claims.nonce,
    resource: claims.resource,
    merchant: claims.merchant,
    payer: claims.payer,
    chain: claims.chain,
    asset: claims.asset,
  })
    .setProtectedHeader({ alg: RECEIPT_ALG, kid: "merchant-receipt-key" })
    .setIssuer(RECEIPT_ISSUER)
    .setAudience(RECEIPT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(receiptKeys.privateKey);
}

export async function verifyReceiptJwt(
  token: string
): Promise<{ valid: true; claims: ReceiptClaims } | { valid: false; reason: string }> {
  try {
    const { payload } = await jwtVerify(token, receiptKeys.publicKey, {
      issuer: RECEIPT_ISSUER,
      audience: RECEIPT_AUDIENCE,
      algorithms: [RECEIPT_ALG],
    });
    const txId = String(payload.txId ?? "");
    const nonce = String(payload.nonce ?? "");
    const resource = String(payload.resource ?? "");
    const merchant = String(payload.merchant ?? "");
    const payer = String(payload.payer ?? "");
    const chain = String(payload.chain ?? "");
    const asset = payload.asset === "USDT" || payload.asset === "TRX" ? payload.asset : null;
    if (!txId || !resource || !merchant || !asset) {
      return { valid: false, reason: "Missing required claims" };
    }
    return {
      valid: true,
      claims: { txId, nonce, resource, merchant, payer, chain, asset },
    };
  } catch (e) {
    return { valid: false, reason: String(e) };
  }
}

export async function getReceiptVerificationInfo(): Promise<{
  alg: string;
  issuer: string;
  audience: string;
  publicKeyPem: string;
  jwk: Record<string, unknown>;
  keySource: "env" | "generated";
}> {
  publicJwkPromise ??= exportJWK(receiptKeys.publicKey).then((jwk) => ({
    ...jwk,
    alg: RECEIPT_ALG,
    use: "sig",
    kid: "merchant-receipt-key",
  }));

  return {
    alg: RECEIPT_ALG,
    issuer: RECEIPT_ISSUER,
    audience: RECEIPT_AUDIENCE,
    publicKeyPem: receiptKeys.publicKeyPem,
    jwk: await publicJwkPromise,
    keySource: receiptKeys.source,
  };
}
