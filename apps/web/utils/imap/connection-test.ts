import * as dns from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "@/env";
import { getErrorMessage } from "@/utils/error";
import { withImapConnection } from "@/utils/imap/client";
import { buildFolderMap, type MailboxRole } from "@/utils/imap/folder";
import { verifySmtpConnection } from "@/utils/imap/smtp";
import type { ImapConnectionConfig } from "@/utils/imap/types";

export type ImapConnectionTestResult =
  | {
      ok: true;
      folders: Partial<Record<MailboxRole, string>>;
      folderCount: number;
    }
  | { ok: false; stage: "host" | "imap" | "smtp"; error: string };

/** Logs in over IMAP and SMTP with the given settings without storing anything. */
export async function testImapConnection(
  config: ImapConnectionConfig,
): Promise<ImapConnectionTestResult> {
  for (const host of [config.imapHost, config.smtpHost]) {
    const hostError = await checkHostAllowed(host);
    if (hostError) return { ok: false, stage: "host", error: hostError };
  }

  let folders: Partial<Record<MailboxRole, string>>;
  let folderCount: number;
  try {
    const map = await withImapConnection(config, async (session) =>
      buildFolderMap(await session.listMailboxes({ fresh: true })),
    );
    folders = map.byRole;
    folderCount = map.selectable.length;
  } catch (error) {
    return { ok: false, stage: "imap", error: describeError(error) };
  }

  try {
    await verifySmtpConnection(config);
  } catch (error) {
    return { ok: false, stage: "smtp", error: describeError(error) };
  }

  return { ok: true, folders, folderCount };
}

/**
 * The host comes from the user, so refuse internal addresses: otherwise the
 * form could be used to probe services next to the app. Self-hosters with a
 * mail server on their LAN can opt out with IMAP_ALLOW_PRIVATE_HOSTS.
 */
async function checkHostAllowed(host: string): Promise<string | null> {
  if (env.IMAP_ALLOW_PRIVATE_HOSTS) return null;
  if (host.toLowerCase() === "localhost") return `${host} is not allowed`;
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    return `Could not resolve ${host}`;
  }
  if (addresses.some(isPrivateAddress)) {
    return `${host} points to a private network address`;
  }
  return null;
}

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^::$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  /^::ffff:(127|10|192\.168|169\.254)\./i,
];

export function isPrivateAddress(address: string) {
  return PRIVATE_RANGES.some((range) => range.test(address));
}

function describeError(error: unknown) {
  const message = getErrorMessage(error) ?? "Connection failed";
  const response =
    typeof error === "object" && error && "responseText" in error
      ? String((error as { responseText?: unknown }).responseText ?? "")
      : "";
  const detail = response && !message.includes(response) ? `: ${response}` : "";
  if (/auth|login|credential|535|invalid/i.test(message + response)) {
    return `Sign-in was rejected${detail || `: ${message}`}. Most providers need an app password or authorization code, not your web password.`;
  }
  return `${message}${detail}`;
}
