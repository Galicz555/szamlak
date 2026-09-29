import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// Enable Banking accepts tokens living at most 24h; one hour is plenty for a single call.
const JWT_LIFETIME_SECONDS = 3600;

export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("Enable Banking key must be an RSA key");
  return key;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** RS256 token, as Enable Banking requires: kid = application id, lifetime at most 24h. */
export function signJwt(appId: string, key: KeyObject, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(
    JSON.stringify({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: nowSeconds,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}
