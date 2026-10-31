import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type RedirectSsoConfig,
  verifySsoToken,
} from "@/utils/auth/redirect-sso";

const config: RedirectSsoConfig = {
  baseUrl: "https://auth.example.com",
  issuers: ["http://10.0.0.1:8849", "https://auth.example.com"],
  audience: "apps",
  requiredRoles: ["admin"],
  emailDomain: "example.com",
  allowSignUp: false,
};

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

function sign(claims: Record<string, unknown>, issuer = config.issuers[0]) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience("apps")
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("verifySsoToken", () => {
  it("accepts any allowlisted issuer and derives the email from the username", async () => {
    const token = await sign(
      { preferred_username: "Owner", name: "Owner", roles: ["admin"] },
      "https://auth.example.com",
    );
    await expect(verifySsoToken(token, config, jwks)).resolves.toMatchObject({
      username: "Owner",
      email: "owner@example.com",
    });
  });

  it("rejects users without a required role", async () => {
    const token = await sign({ preferred_username: "guest", roles: ["guest"] });
    await expect(verifySsoToken(token, config, jwks)).rejects.toThrow(
      "isn't allowed",
    );
  });

  it("rejects tokens from another issuer or audience", async () => {
    const otherIssuer = await sign(
      { preferred_username: "owner", roles: ["admin"] },
      "https://evil.example.com",
    );
    await expect(verifySsoToken(otherIssuer, config, jwks)).rejects.toThrow(
      "invalid",
    );
    const otherAudience = await new SignJWT({
      preferred_username: "owner",
      roles: ["admin"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(config.issuers[0])
      .setAudience("other")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifySsoToken(otherAudience, config, jwks)).rejects.toThrow(
      "invalid",
    );
  });

  it("rejects unsigned tokens", async () => {
    const header = Buffer.from('{"alg":"none"}').toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: config.issuers[0],
        aud: "apps",
        preferred_username: "owner",
        roles: ["admin"],
      }),
    ).toString("base64url");
    await expect(
      verifySsoToken(`${header}.${body}.`, config, jwks),
    ).rejects.toThrow("invalid");
  });
});
