"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import Image from "next/image";
import { MailIcon } from "lucide-react";
import { MutedText } from "@/components/Typography";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { redirectToSafeUrl } from "@/utils/redirect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddImapAccountForm } from "@/app/(app)/accounts/AddImapAccountForm";

export function AddAccount({
  helperText = "You will be billed for each account.",
}: {
  helperText?: ReactNode;
}) {
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [isLoadingMicrosoft, setIsLoadingMicrosoft] = useState(false);
  const [isImapOpen, setIsImapOpen] = useState(false);

  const handleAddAccount = async (provider: "google" | "microsoft") => {
    const setLoading = isGoogleProvider(provider)
      ? setIsLoadingGoogle
      : setIsLoadingMicrosoft;
    setLoading(true);

    try {
      const url = await getAccountLinkingUrl(provider);
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      console.error(`Error initiating ${provider} link:`, error);
      toastError({
        title: `Error initiating ${isGoogleProvider(provider) ? "Google" : "Microsoft"} link`,
        description:
          error instanceof Error
            ? error.message
            : "Please try again or contact support",
      });
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3 min-h-[90px]">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => handleAddAccount("google")}
          loading={isLoadingGoogle}
          disabled={isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/google.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Google</span>
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => handleAddAccount("microsoft")}
          loading={isLoadingMicrosoft}
          disabled={isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/microsoft.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Microsoft</span>
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => setIsImapOpen(true)}
          disabled={isLoadingGoogle || isLoadingMicrosoft}
        >
          <MailIcon className="size-5" />
          <span className="ml-2">Add IMAP</span>
        </Button>
      </div>

      <Dialog open={isImapOpen} onOpenChange={setIsImapOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect an IMAP mailbox</DialogTitle>
            <DialogDescription>
              Works with NetEase, QQ Mail, Gmail (app password) and any
              IMAP/SMTP server.
            </DialogDescription>
          </DialogHeader>
          <AddImapAccountForm
            onConnected={(emailAccountId) => {
              setIsImapOpen(false);
              redirectToSafeUrl(`/${emailAccountId}/setup`);
            }}
          />
        </DialogContent>
      </Dialog>

      <MutedText>{helperText}</MutedText>
    </div>
  );
}
