import { z } from "zod";

export const imapSecuritySchema = z.enum(["tls", "starttls"]);
export type ImapSecurity = z.infer<typeof imapSecuritySchema>;

export type ImapConnectionConfig = {
  imapHost: string;
  imapPort: number;
  imapSecurity: ImapSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: ImapSecurity;
  username: string;
  password: string;
  /** The mailbox address, used as the From address and in logs. */
  email: string;
};

export type ImapCredentialConfig = ImapConnectionConfig & {
  emailAccountId: string;
  /** Changes whenever the stored settings change, so pooled connections are rebuilt. */
  version: string;
};

export class UnsupportedImapOperationError extends Error {
  constructor(operation: string) {
    super(`"${operation}" is not supported for IMAP accounts`);
    this.name = "UnsupportedImapOperationError";
  }
}

export class ImapMessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`IMAP message not found: ${messageId}`);
    this.name = "ImapMessageNotFoundError";
  }
}
