import { createHash } from "node:crypto";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import {
  type ImapCredentialConfig,
  imapSecuritySchema,
} from "@/utils/imap/types";

/** Loads the IMAP settings for an email account. The password is decrypted by the Prisma extension. */
export async function getImapCredentials(
  emailAccountId: string,
): Promise<ImapCredentialConfig> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { email: true, accountId: true },
  });
  if (!emailAccount) throw new SafeError("Email account not found");

  const credential = await prisma.imapCredential.findUnique({
    where: { accountId: emailAccount.accountId },
  });
  if (!credential?.password) {
    throw new SafeError("IMAP settings are missing for this account");
  }

  const config = {
    email: emailAccount.email,
    imapHost: credential.imapHost,
    imapPort: credential.imapPort,
    imapSecurity: imapSecuritySchema
      .catch("tls")
      .parse(credential.imapSecurity),
    smtpHost: credential.smtpHost,
    smtpPort: credential.smtpPort,
    smtpSecurity: imapSecuritySchema
      .catch("tls")
      .parse(credential.smtpSecurity),
    username: credential.username,
    password: credential.password,
  };

  return {
    ...config,
    emailAccountId,
    // Poll bookkeeping also bumps updatedAt, so derive the version from the
    // connection settings alone.
    version: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
  };
}
