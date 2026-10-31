import nodemailer from "nodemailer";
import type { ImapConnectionConfig } from "@/utils/imap/types";

const SMTP_TIMEOUT_MS = 30_000;

export function createSmtpTransport(config: ImapConnectionConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecurity === "tls",
    requireTLS: config.smtpSecurity === "starttls",
    auth: { user: config.username, pass: config.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

/** Sends an already-built RFC 822 message, so the copy saved to Sent is byte-identical. */
export async function sendRawSmtpMessage(
  config: ImapConnectionConfig,
  {
    raw,
    from,
    recipients,
  }: { raw: Buffer; from: string; recipients: string[] },
) {
  if (!recipients.length) throw new Error("Email has no recipients");
  const transport = createSmtpTransport(config);
  try {
    return await transport.sendMail({
      envelope: { from, to: recipients },
      raw,
    });
  } finally {
    transport.close();
  }
}

export async function verifySmtpConnection(config: ImapConnectionConfig) {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}
