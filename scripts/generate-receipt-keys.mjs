#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().trim();
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString().trim();

const escapePem = (value) => value.replace(/\n/g, "\\n");

console.log("# Paste these into .env for stable ES256 receipt verification");
console.log(`RECEIPT_PRIVATE_KEY_PEM="${escapePem(privatePem)}"`);
console.log(`RECEIPT_PUBLIC_KEY_PEM="${escapePem(publicPem)}"`);
