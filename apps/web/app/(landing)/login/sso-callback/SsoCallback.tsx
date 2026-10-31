"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WELCOME_PATH } from "@/utils/config";
import { normalizeInternalPath } from "@/utils/path";
import { redirectToSafeUrl } from "@/utils/redirect";

export function SsoCallback() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // The token arrives in the URL fragment, which only the browser can read,
  // so the exchange has to start from an effect.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Drop the token from the address bar and history right away.
    window.history.replaceState(null, "", window.location.pathname);
    const accessToken = params.get("access_token");
    const state = params.get("state");
    if (!accessToken || !state) {
      setError("Sign-in did not complete. Please try again.");
      return;
    }
    fetch("/api/auth/redirect-sso/session", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken, state }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          next?: string | null;
          message?: string;
        } | null;
        if (!response.ok) {
          setError(body?.message || "Sign-in failed. Please try again.");
          return;
        }
        redirectToSafeUrl(normalizeInternalPath(body?.next) ?? WELCOME_PATH);
      })
      .catch(() => setError("Sign-in failed. Please try again."));
  }, []);

  if (!error) {
    return <p className="text-muted-foreground">Signing you in…</p>;
  }
  return (
    <div className="space-y-4 text-center">
      <p role="alert" className="text-destructive">
        {error}
      </p>
      <Button variant="outline" asChild>
        <Link href="/login">Back to sign in</Link>
      </Button>
    </div>
  );
}
