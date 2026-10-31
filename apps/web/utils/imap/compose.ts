import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";
import type Mail from "nodemailer/lib/mailer";

export type ComposeOptions = Mail.Options & {
  /** The Sent copy keeps Bcc; the copy handed to SMTP must not carry it. */
  keepBcc?: boolean;
};

export async function buildMime({
  keepBcc = false,
  ...options
}: ComposeOptions): Promise<Buffer> {
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = keepBcc;
  return compiled.build();
}

export function generateMessageId(fromEmail: string) {
  const domain = fromEmail.split("@")[1]?.trim() || "inbox-zero.local";
  return `<${randomUUID()}@${domain}>`;
}

/** Bare addresses from To/Cc/Bcc header values, for the SMTP envelope. */
export function collectRecipients(
  ...values: Array<string | undefined>
): string[] {
  const addresses = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const entry of flatten(addressparser(value))) {
      if (entry.address) addresses.add(entry.address.toLowerCase());
    }
  }
  return [...addresses];
}

export function extractAddress(value: string | undefined): string | undefined {
  if (!value) return;
  return flatten(addressparser(value)).find((entry) => entry.address)?.address;
}

type ParsedAddress = ReturnType<typeof addressparser>[number];

function flatten(entries: ParsedAddress[]): Array<{ address?: string }> {
  return entries.flatMap((entry) =>
    "group" in entry && entry.group ? flatten(entry.group) : [entry],
  );
}
