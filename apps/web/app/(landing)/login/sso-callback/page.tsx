import type { Metadata } from "next";
import { SsoCallback } from "@/app/(landing)/login/sso-callback/SsoCallback";
import { getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Signing in"),
  // The URL fragment carries a token; keep it out of Referer headers.
  referrer: "no-referrer",
};

export default function SsoCallbackPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <SsoCallback />
    </main>
  );
}
