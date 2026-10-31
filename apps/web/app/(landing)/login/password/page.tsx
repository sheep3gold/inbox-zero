import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "@/env";
import { PasswordLoginForm } from "@/app/(landing)/login/password/PasswordLoginForm";
import { auth } from "@/utils/auth";
import { getBrandTitle } from "@/utils/branding";
import { WELCOME_PATH } from "@/utils/config";
import { normalizeInternalPath } from "@/utils/path";

export const metadata: Metadata = {
  title: getBrandTitle("Sign in with password"),
};

export default async function PasswordLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  if (!env.PASSWORD_LOGIN_ENABLED) notFound();

  const params = await searchParams;
  const callbackURL =
    normalizeInternalPath(
      typeof params.next === "string" ? params.next : undefined,
    ) ?? WELCOME_PATH;
  const session = await auth();
  if (session?.user) redirect(callbackURL);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <PasswordLoginForm callbackURL={callbackURL} />
      </div>
    </main>
  );
}
