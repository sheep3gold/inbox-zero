export function isGoogleProvider(
  provider: string | null | undefined,
): provider is "google" {
  return provider === "google";
}

export function isImapProvider(
  provider: string | null | undefined,
): provider is "imap" {
  return provider === "imap";
}

/** IMAP accounts authenticate with stored credentials instead of OAuth tokens. */
export function hasMailboxCredentials(account: {
  provider: string;
  refresh_token?: string | null;
}) {
  return isImapProvider(account.provider) || !!account.refresh_token;
}

/** Providers whose mailboxes are organized in folders that mail can be moved into. */
export function supportsFolders(provider: string | null | undefined) {
  return isMicrosoftProvider(provider) || isImapProvider(provider);
}

export function isMicrosoftProvider(
  provider: string | null | undefined,
): provider is "microsoft" {
  return provider === "microsoft";
}
