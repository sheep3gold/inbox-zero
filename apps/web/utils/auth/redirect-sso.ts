import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { normalizeInternalPath } from "@/utils/path";

const logger = createScopedLogger("auth/redirect-sso");

const STATE_COOKIE = "redirect_sso_state";
const STATE_MAX_AGE_SECONDS = 300;
export const REDIRECT_SSO_CALLBACK_PATH = "/login/sso-callback";

/**
 * Sign-in through a central login page that redirects back with an access
 * token in the URL fragment (the authService "SSO redirect" flow):
 *
 *   /api/auth/redirect-sso/start  -> {REDIRECT_SSO_URL}/login?redirect_uri=..&state=..
 *   {REDIRECT_SSO_URL}            -> /login/sso-callback#access_token=..&state=..
 *   /login/sso-callback (JS)      -> POST /api/auth/redirect-sso/session
 *
 * The token is verified locally against the provider's JWKS (RS256, issuer
 * allowlist, audience, required role) and only used to establish who signed
 * in; the session is a normal Better Auth session. The fragment keeps the
 * token out of server logs and Referer headers, which is why the callback is
 * a page and the exchange is a POST.
 */
export type RedirectSsoConfig = {
  baseUrl: string;
  issuers: string[];
  audience: string;
  requiredRoles: string[];
  emailDomain: string;
  allowSignUp: boolean;
};

export function getRedirectSsoConfig(): RedirectSsoConfig | null {
  if (!env.REDIRECT_SSO_URL) return null;
  if (!env.REDIRECT_SSO_AUDIENCE) {
    throw new Error("REDIRECT_SSO_AUDIENCE is required with REDIRECT_SSO_URL");
  }
  const baseUrl = env.REDIRECT_SSO_URL.replace(/\/+$/, "");
  return {
    baseUrl,
    issuers: splitList(env.REDIRECT_SSO_ISSUERS) ?? [baseUrl],
    audience: env.REDIRECT_SSO_AUDIENCE,
    requiredRoles: splitList(env.REDIRECT_SSO_REQUIRED_ROLES) ?? [],
    emailDomain: env.REDIRECT_SSO_EMAIL_DOMAIN ?? new URL(baseUrl).hostname,
    allowSignUp: env.REDIRECT_SSO_SIGNUP_ENABLED,
  };
}

export function redirectSso(config: RedirectSsoConfig) {
  const jwks = createRemoteJWKSet(
    new URL(`${config.baseUrl}/.well-known/jwks.json`),
    { cacheMaxAge: 60 * 60 * 1000 },
  );

  return {
    id: "redirect-sso",
    endpoints: {
      redirectSsoStart: createAuthEndpoint(
        "/redirect-sso/start",
        {
          method: "GET",
          query: z.object({ next: z.string().optional() }),
        },
        async (ctx) => {
          const state = randomBytes(24).toString("base64url");
          const next = normalizeInternalPath(ctx.query.next) ?? "";
          const cookie = ctx.context.createAuthCookie(STATE_COOKIE, {
            maxAge: STATE_MAX_AGE_SECONDS,
          });
          await ctx.setSignedCookie(
            cookie.name,
            `${state}.${next}`,
            ctx.context.secret,
            cookie.attributes,
          );
          const callback = new URL(
            REDIRECT_SSO_CALLBACK_PATH,
            env.NEXT_PUBLIC_BASE_URL,
          );
          const login = new URL(`${config.baseUrl}/login`);
          login.searchParams.set("redirect_uri", callback.toString());
          login.searchParams.set("state", state);
          return ctx.redirect(login.toString());
        },
      ),
      redirectSsoSession: createAuthEndpoint(
        "/redirect-sso/session",
        {
          method: "POST",
          body: z.object({
            access_token: z.string().min(1).max(8192),
            state: z.string().min(1).max(256),
          }),
        },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie(STATE_COOKIE);
          const stored = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
          const value = typeof stored === "string" ? stored : "";
          const separator = value.indexOf(".");
          const expectedState = separator > 0 ? value.slice(0, separator) : "";
          if (!expectedState || !safeEqual(expectedState, ctx.body.state)) {
            throw new APIError("BAD_REQUEST", {
              message: "Sign-in expired. Please try again.",
            });
          }
          const next = value.slice(separator + 1) || null;

          const identity = await verifySsoToken(
            ctx.body.access_token,
            config,
            jwks,
          );

          const existing = await ctx.context.internalAdapter.findUserByEmail(
            identity.email,
          );
          let user = existing?.user;
          if (!user) {
            if (!config.allowSignUp) {
              logger.warn("SSO sign-in for an unknown user", {
                username: identity.username,
              });
              throw new APIError("FORBIDDEN", {
                message: "No Inbox Zero account exists for this user.",
              });
            }
            user = await ctx.context.internalAdapter.createUser(
              {
                email: identity.email,
                emailVerified: true,
                name: identity.name,
              },
              { method: "redirect-sso" },
            );
          }

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          await setSessionCookie(ctx, { session, user });
          logger.info("Signed in through redirect SSO", { userId: user.id });
          return ctx.json({ ok: true, next });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

export async function verifySsoToken(
  token: string,
  config: RedirectSsoConfig,
  jwks: Parameters<typeof jwtVerify>[1],
) {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwks as never, {
      algorithms: ["RS256"],
      issuer: config.issuers,
      audience: config.audience,
    }));
  } catch {
    throw new APIError("UNAUTHORIZED", {
      message: "Sign-in token is invalid.",
    });
  }

  const username =
    typeof payload.preferred_username === "string"
      ? payload.preferred_username
      : "";
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === "string")
    : [];
  if (!username) {
    throw new APIError("UNAUTHORIZED", {
      message: "Sign-in token is invalid.",
    });
  }
  if (
    config.requiredRoles.length &&
    !roles.some((role) => config.requiredRoles.includes(role))
  ) {
    throw new APIError("FORBIDDEN", {
      message: "Your account isn't allowed to use Inbox Zero.",
    });
  }

  const email =
    typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email.toLowerCase()
      : `${username}@${config.emailDomain}`.toLowerCase();
  const name = typeof payload.name === "string" ? payload.name : username;
  return { username, email, name, roles };
}

function splitList(value: string | undefined) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
