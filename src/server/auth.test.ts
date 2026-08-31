import { describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { verifyToleratingExpiry } from "./auth.ts";

const nowSec = () => Math.floor(Date.now() / 1000);
const AUD = "spa-client-id";

async function sign(
  key: CryptoKey,
  claims: Record<string, unknown>,
  expSec: number,
  aud: string = AUD,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setAudience(aud)
    .setIssuedAt(nowSec() - 7200)
    .setExpirationTime(expSec)
    .sign(key);
}

// Expiry is tolerated, but signature and audience must still bite.
describe("verifyToleratingExpiry", () => {
  const opts = { algorithms: ["RS256"], audience: AUD };

  test("accepts an expired token with a good signature and audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await sign(
      privateKey,
      { email: "Henrik@Entur.org", sub: "auth0|123" },
      nowSec() - 3600, // expired an hour ago
    );
    const { payload } = await verifyToleratingExpiry(
      token,
      () => publicKey,
      opts,
    );
    expect(payload.email).toBe("Henrik@Entur.org");
    expect(payload.sub).toBe("auth0|123");
  });

  test("accepts a still-valid token unchanged", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await sign(privateKey, { sub: "s" }, nowSec() + 3600);
    const { payload } = await verifyToleratingExpiry(
      token,
      () => publicKey,
      opts,
    );
    expect(payload.sub).toBe("s");
  });

  test("still rejects a forged (wrong-key) token", async () => {
    const signer = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const token = await sign(signer.privateKey, { sub: "s" }, nowSec() - 3600);
    await expect(
      verifyToleratingExpiry(token, () => other.publicKey, opts),
    ).rejects.toThrow();
  });

  test("still rejects a wrong-audience token (only time is relaxed)", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await sign(
      privateKey,
      { sub: "s" },
      nowSec() - 3600,
      "some-other-client",
    );
    await expect(
      verifyToleratingExpiry(token, () => publicKey, opts),
    ).rejects.toThrow();
  });
});
