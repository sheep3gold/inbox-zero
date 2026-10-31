"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { signIn, signUp } from "@/utils/auth-client";
import { buildRedirectUrl, redirectToSafeUrl } from "@/utils/redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasswordLoginForm({ callbackURL }: { callbackURL: string }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm({ defaultValues: { name: "", email: "", password: "" } });

  const submit = handleSubmit(async ({ name, email, password }) => {
    setError(null);
    const address = email.trim().toLowerCase();
    try {
      const result =
        mode === "sign-in"
          ? await signIn.email({ email: address, password })
          : await signUp.email({
              email: address,
              password,
              name: name.trim() || address,
            });
      if (result.error) {
        setError(
          result.error.message ||
            (mode === "sign-in"
              ? "Incorrect email or password."
              : "Could not create the account."),
        );
        return;
      }
      redirectToSafeUrl(callbackURL);
    } catch {
      setError("Unable to sign in. Please try again.");
    }
  });

  const isSignUp = mode === "sign-up";

  return (
    <form className="space-y-6" onSubmit={submit}>
      <div className="space-y-2 text-center">
        <h1 className="font-title text-2xl">
          {isSignUp ? "Create an account" : "Sign in"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Connect IMAP mailboxes after signing in.
        </p>
      </div>
      {isSignUp && (
        <div className="space-y-2">
          <Label htmlFor="login-name">Name</Label>
          <Input id="login-name" autoComplete="name" {...register("name")} />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          {...register("email")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          minLength={isSignUp ? 10 : undefined}
          required
          {...register("password")}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button className="w-full" type="submit" loading={isSubmitting}>
        {isSignUp ? "Create account" : "Sign in"}
      </Button>
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        disabled={isSubmitting}
        onClick={() => {
          setMode(isSignUp ? "sign-in" : "sign-up");
          setError(null);
        }}
      >
        {isSignUp ? "I already have an account" : "Create an account"}
      </Button>
      <Button className="w-full" variant="ghost" asChild>
        <Link href={buildRedirectUrl("/login", { next: callbackURL })}>
          Back
        </Link>
      </Button>
    </form>
  );
}
