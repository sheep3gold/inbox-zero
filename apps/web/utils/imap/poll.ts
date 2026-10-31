import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import { canonicalizeEmailAddress } from "@/utils/email";
import { runWithBoundedConcurrency } from "@/utils/async";
import { describeError } from "@/utils/imap/connection-test";
import { acquireOwnedLock, clearOwnedLock } from "@/utils/redis/owned-lock";
import { withMessageProcessingLock } from "@/utils/redis/message-processing";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { type ImapSession, withImapSession } from "@/utils/imap/client";
import { getImapCredentials } from "@/utils/imap/credential";
import { fetchMessages, getFolders, searchUids } from "@/utils/imap/mailbox";
import type { ParsedMessage } from "@/utils/types";

// Bounds one poll so a large backlog is worked off over several runs.
const MAX_MESSAGES_PER_FOLDER = 25;
const ACCOUNT_CONCURRENCY = 3;
const POLL_LOCK_TTL_SECONDS = 5 * 60;

export type ImapPollResult = {
  emailAccountId: string;
  processed: number;
  skipped?: "locked" | "baseline";
  error?: string;
};

type FolderState = { uidValidity: bigint | null; lastUid: number | null };

type FolderCheck = {
  path: string;
  uidValidity: bigint;
  newUids: number[];
  baseline: boolean;
  highestUid: number;
};

export async function pollAllImapAccounts(
  logger: Logger,
): Promise<ImapPollResult[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { account: { provider: "imap", disconnectedAt: null } },
    select: { id: true },
  });
  if (!accounts.length) return [];

  const results = await runWithBoundedConcurrency({
    items: accounts,
    concurrency: ACCOUNT_CONCURRENCY,
    run: (account) =>
      pollImapAccount({
        emailAccountId: account.id,
        logger: logger.with({ emailAccountId: account.id }),
      }),
  });

  return results.map(({ item, result }) =>
    result.status === "fulfilled"
      ? result.value
      : {
          emailAccountId: item.id,
          processed: 0,
          error: describeError(result.reason),
        },
  );
}

/**
 * Finds mail that arrived since the last poll by UID and hands it to the same
 * pipeline the Gmail and Outlook webhooks use. The first poll only records a
 * baseline, so connecting an account never runs rules over old mail.
 */
export async function pollImapAccount({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<ImapPollResult> {
  const lockKey = `imap-poll:${emailAccountId}`;
  const lockToken = await acquireOwnedLock({
    key: lockKey,
    processingTtlSeconds: POLL_LOCK_TTL_SECONDS,
  });
  if (!lockToken) return { emailAccountId, processed: 0, skipped: "locked" };

  try {
    return await pollLocked(emailAccountId, logger);
  } catch (error) {
    const message = describeError(error);
    logger.warn("IMAP poll failed", { error });
    await prisma.imapCredential
      .updateMany({
        where: { account: { emailAccount: { id: emailAccountId } } },
        data: {
          lastPollError: message.slice(0, 500),
          lastPolledAt: new Date(),
        },
      })
      .catch(() => undefined);
    return { emailAccountId, processed: 0, error: message };
  } finally {
    await clearOwnedLock({ key: lockKey, lockToken }).catch(() => undefined);
  }
}

async function pollLocked(emailAccountId: string, logger: Logger) {
  const credential = await prisma.imapCredential.findFirst({
    where: { account: { emailAccount: { id: emailAccountId } } },
    select: {
      id: true,
      inboxUidValidity: true,
      inboxLastUid: true,
      sentUidValidity: true,
      sentLastUid: true,
    },
  });
  if (!credential) throw new Error("IMAP settings not found");

  const config = await getImapCredentials(emailAccountId);

  const { inbox, sent, inboxMessages, sentMessages } = await withImapSession(
    config,
    async (session) => {
      const folders = await getFolders(session);
      const inboxPath = folders.byRole.inbox ?? "INBOX";
      const inbox = await checkFolder(session, inboxPath, {
        uidValidity: credential.inboxUidValidity,
        lastUid: credential.inboxLastUid,
      });
      const sent = folders.byRole.sent
        ? await checkFolder(session, folders.byRole.sent, {
            uidValidity: credential.sentUidValidity,
            lastUid: credential.sentLastUid,
          })
        : null;
      return {
        inbox,
        sent,
        inboxMessages: await fetchMessages(
          session,
          folders,
          inbox.path,
          inbox.newUids,
        ),
        sentMessages: sent
          ? await fetchMessages(session, folders, sent.path, sent.newUids)
          : [],
      };
    },
  );

  let processed = 0;
  const messages = [...inboxMessages, ...sentMessages];
  if (messages.length) {
    processed = await processMessages({
      emailAccountId,
      email: config.email,
      messages,
      logger,
    });
  }

  await prisma.imapCredential.update({
    where: { id: credential.id },
    data: {
      inboxUidValidity: inbox.uidValidity,
      inboxLastUid: inbox.highestUid,
      ...(sent && {
        sentUidValidity: sent.uidValidity,
        sentLastUid: sent.highestUid,
      }),
      lastPolledAt: new Date(),
      lastPollError: null,
    },
  });

  if (inbox.baseline) {
    logger.info("Recorded IMAP poll baseline");
    return { emailAccountId, processed, skipped: "baseline" as const };
  }
  return { emailAccountId, processed };
}

async function checkFolder(
  session: ImapSession,
  path: string,
  state: FolderState,
): Promise<FolderCheck> {
  const { uidValidity, uidNext } = await session.withMailbox(
    path,
    async (mailbox) => mailbox,
    { readOnly: true },
  );
  const lastUid = state.lastUid ?? 0;
  if (state.uidValidity === null || state.uidValidity !== uidValidity) {
    return {
      path,
      uidValidity,
      newUids: [],
      baseline: true,
      highestUid: Math.max(0, uidNext - 1),
    };
  }
  if (uidNext <= lastUid + 1) {
    return {
      path,
      uidValidity,
      newUids: [],
      baseline: false,
      highestUid: lastUid,
    };
  }

  // "n:*" always includes the highest UID, even when it is below n.
  const newUids = (await searchUids(session, path, { uid: `${lastUid + 1}:*` }))
    .filter((uid) => uid > lastUid)
    .sort((a, b) => a - b)
    .slice(0, MAX_MESSAGES_PER_FOLDER);

  return {
    path,
    uidValidity,
    newUids,
    baseline: false,
    highestUid: newUids.at(-1) ?? lastUid,
  };
}

async function processMessages({
  emailAccountId,
  email,
  messages,
  logger,
}: {
  emailAccountId: string;
  email: string;
  messages: ParsedMessage[];
  logger: Logger;
}) {
  const emailAccount = await getWebhookEmailAccount({ email }, logger);
  const provider = await createEmailProvider({
    emailAccountId,
    provider: "imap",
    logger,
  });

  // Auto-archive is enforced here because IMAP has no server-side filters.
  const remaining: ParsedMessage[] = [];
  for (const message of messages) {
    if (await autoArchiveIfNeeded({ emailAccountId, message, provider })) {
      logger.info("Auto-archived message from sender");
      continue;
    }
    remaining.push(message);
  }

  const validation = await validateWebhookAccount(emailAccount, logger);
  if (!validation.success) return messages.length - remaining.length;

  const {
    emailAccount: validatedEmailAccount,
    hasAutomationRules,
    hasAiAccess,
  } = validation.data;

  let processed = messages.length - remaining.length;
  for (const message of remaining) {
    const messageLogger = logger.with({ messageId: message.id });
    try {
      await withMessageProcessingLock(
        { userEmail: validatedEmailAccount.email, messageId: message.id },
        () =>
          processHistoryItem(
            { messageId: message.id, threadId: message.threadId, message },
            {
              provider,
              isNewMessage: true,
              emailAccount: {
                ...validatedEmailAccount,
                account: { provider: "imap" },
              },
              hasAutomationRules,
              hasAiAccess,
              rules: validatedEmailAccount.rules,
              logger: messageLogger,
            },
          ),
      );
      processed++;
    } catch (error) {
      messageLogger.error("Failed to process IMAP message", { error });
    }
  }
  return processed;
}

async function autoArchiveIfNeeded({
  emailAccountId,
  message,
  provider,
}: {
  emailAccountId: string;
  message: ParsedMessage;
  provider: EmailProvider;
}) {
  if (!message.labelIds?.includes("INBOX")) return false;
  const sender = canonicalizeEmailAddress(message.headers.from);
  if (!sender) return false;
  const newsletter = await prisma.newsletter.findFirst({
    where: {
      emailAccountId,
      email: { equals: sender, mode: "insensitive" },
      status: NewsletterStatus.AUTO_ARCHIVED,
    },
    select: { id: true },
  });
  if (!newsletter) return false;
  await provider.archiveMessage(message.id);
  return true;
}
