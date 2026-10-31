"use server";

import { after } from "next/server";
import { actionClientUser } from "@/utils/actions/safe-action";
import { imapConnectionBody } from "@/utils/actions/imap.validation";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { isImapProvider } from "@/utils/email/provider-types";
import { testImapConnection } from "@/utils/imap/connection-test";
import { resetImapSession } from "@/utils/imap/client";
import { INITIAL_MAIL_SPLITS } from "@/utils/split-inbox/initial-splits";
import { updateAccountSeats } from "@/utils/premium/seats";
import { ensureEmailAccountsWatched } from "@/utils/email/watch-manager";

export const testImapConnectionAction = actionClientUser
  .metadata({ name: "testImapConnection" })
  .inputSchema(imapConnectionBody)
  .action(async ({ parsedInput }) => testImapConnection(parsedInput));

/**
 * Connects an IMAP mailbox to the signed-in user, or updates the settings of
 * one they already connected. The settings are checked against the server
 * before anything is stored.
 */
export const connectImapAccountAction = actionClientUser
  .metadata({ name: "connectImapAccount" })
  .inputSchema(imapConnectionBody)
  .action(async ({ parsedInput, ctx: { userId, logger } }) => {
    const test = await testImapConnection(parsedInput);
    if (!test.ok) throw new SafeError(test.error);

    const existing = await prisma.emailAccount.findUnique({
      where: { email: parsedInput.email },
      select: {
        id: true,
        userId: true,
        accountId: true,
        account: { select: { provider: true } },
      },
    });
    if (existing && existing.userId !== userId) {
      throw new SafeError("This mailbox is already connected to another user.");
    }
    if (existing && !isImapProvider(existing.account.provider)) {
      throw new SafeError(
        "This mailbox is already connected with Google or Microsoft.",
      );
    }

    const credential = {
      imapHost: parsedInput.imapHost,
      imapPort: parsedInput.imapPort,
      imapSecurity: parsedInput.imapSecurity,
      smtpHost: parsedInput.smtpHost,
      smtpPort: parsedInput.smtpPort,
      smtpSecurity: parsedInput.smtpSecurity,
      username: parsedInput.username,
      password: parsedInput.password,
      lastPollError: null,
    };

    let emailAccountId: string;
    if (existing) {
      await prisma.imapCredential.upsert({
        where: { accountId: existing.accountId },
        create: { ...credential, accountId: existing.accountId },
        update: credential,
      });
      await prisma.account.update({
        where: { id: existing.accountId },
        data: { disconnectedAt: null },
      });
      resetImapSession(existing.id);
      emailAccountId = existing.id;
      logger.info("Updated IMAP account settings");
    } else {
      emailAccountId = await createImapEmailAccount({
        userId,
        email: parsedInput.email,
        credential,
      });
      logger.info("Connected IMAP account");
      await updateAccountSeats({ userId }).catch((error) => {
        logger.error("Failed to update account seats", { error });
      });
    }

    after(() =>
      ensureEmailAccountsWatched({ userIds: [userId], logger }).catch((error) =>
        logger.error("Failed to start IMAP polling", { error }),
      ),
    );

    return { emailAccountId, folders: test.folders };
  });

async function createImapEmailAccount({
  userId,
  email,
  credential,
}: {
  userId: string;
  email: string;
  credential: Omit<
    Parameters<typeof prisma.imapCredential.create>[0]["data"],
    "account" | "accountId"
  >;
}) {
  const last = await prisma.emailAccount.findFirst({
    where: { userId },
    orderBy: { sortOrder: { sort: "desc", nulls: "last" } },
    select: { sortOrder: true },
  });

  const account = await prisma.account.create({
    data: {
      userId,
      provider: "imap",
      type: "imap",
      providerAccountId: email,
      expires_at: null,
    },
    select: { id: true },
  });

  try {
    await prisma.imapCredential.create({
      data: { ...credential, accountId: account.id },
    });
    const emailAccount = await prisma.emailAccount.create({
      data: {
        email,
        name: email.split("@")[0],
        userId,
        accountId: account.id,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        mailSplits: {
          create: INITIAL_MAIL_SPLITS.map((split, order) => ({
            ...split,
            order,
          })),
        },
      },
      select: { id: true },
    });
    return emailAccount.id;
  } catch (error) {
    // Account deletion cascades to the credential.
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
    throw error;
  }
}
