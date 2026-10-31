/**
 * Runs ImapProvider against a real IMAP/SMTP server (GreenMail in CI or
 * locally). Requires two mailboxes on the server:
 *
 *   RUN_INTEGRATION_TESTS=true IMAP_TEST_HOST=mail.example.test \
 *   IMAP_TEST_PORT=3993 SMTP_TEST_PORT=3465 \
 *   IMAP_TEST_USER=alice@example.test IMAP_TEST_PASSWORD=... \
 *   IMAP_TEST_PEER=bob@example.test IMAP_TEST_PEER_PASSWORD=... \
 *   NODE_EXTRA_CA_CERTS=server-cert.pem pnpm test-integration imap-provider
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapProvider } from "@/utils/email/imap";
import { createScopedLogger } from "@/utils/logger";
import { resetImapSession } from "@/utils/imap/client";
import { decodeThreadId } from "@/utils/imap/ids";
import type { ImapCredentialConfig } from "@/utils/imap/types";
import type { ParsedMessage } from "@/utils/types";

const host = process.env.IMAP_TEST_HOST;
const enabled = process.env.RUN_INTEGRATION_TESTS === "true" && !!host;

const imapPort = Number(process.env.IMAP_TEST_PORT || 993);
const smtpPort = Number(process.env.SMTP_TEST_PORT || 465);
const user = process.env.IMAP_TEST_USER || "";
const password = process.env.IMAP_TEST_PASSWORD || "";
const peer = process.env.IMAP_TEST_PEER || "";
const peerPassword = process.env.IMAP_TEST_PEER_PASSWORD || "";

// The NetEase / QQ layout: localized folder names and no Archive folder.
const CHINESE_FOLDERS = ["已发送", "草稿箱", "已删除", "垃圾邮件"];

describe.skipIf(!enabled)("ImapProvider against a live server", () => {
  const config: ImapCredentialConfig = {
    emailAccountId: "imap-integration",
    version: "1",
    email: user,
    username: user,
    password,
    imapHost: host || "",
    imapPort,
    imapSecurity: "tls",
    smtpHost: host || "",
    smtpPort,
    smtpSecurity: "tls",
  };
  const provider = new ImapProvider(
    config,
    createScopedLogger("imap-integration"),
  );
  const subject = `Weekly digest ${Date.now()}`;
  let incoming: ParsedMessage;

  beforeAll(async () => {
    await withClient(user, password, async (client) => {
      const existing = new Set((await client.list()).map((box) => box.path));
      for (const folder of CHINESE_FOLDERS) {
        if (!existing.has(folder)) await client.mailboxCreate(folder);
      }
    });

    await sendAs(peer, peerPassword, {
      to: user,
      subject,
      text: "This week's news. Click to unsubscribe.",
      headers: {
        "List-Unsubscribe": "<https://news.example.test/u?id=1>",
      },
    });
    incoming = await waitFor(async () => {
      const messages = await provider.getInboxMessages(20);
      return messages.find((message) => message.subject === subject);
    });
  }, 60_000);

  afterAll(() => {
    resetImapSession(config.emailAccountId);
  });

  it("lists and reads inbox mail", async () => {
    expect(incoming.labelIds).toEqual(expect.arrayContaining(["INBOX"]));
    expect(incoming.headers["list-unsubscribe"]).toContain("news.example.test");
    const full = await provider.getMessage(incoming.id);
    expect(full.textPlain).toContain("This week's news");
    expect(provider.isSentMessage(full)).toBe(false);
  });

  it("detects localized system folders", async () => {
    const labels = await provider.getLabels();
    const byId = new Map(labels.map((label) => [label.id, label.name]));
    expect(byId.get("SENT")).toBe("已发送");
    expect(byId.get("DRAFT")).toBe("草稿箱");
    // GreenMail always has "Trash" with SPECIAL-USE, which wins over 已删除.
    expect(byId.get("TRASH")).toBeTruthy();
    expect(byId.get("SPAM")).toBe("垃圾邮件");
  });

  it("searches with Gmail-style queries", async () => {
    const { messages } = await provider.searchMessages({
      query: `from:${peer} subject:"${subject}"`,
    });
    expect(messages.map((message) => message.id)).toContain(incoming.id);
  });

  it("labels into a folder and archives without leaving a second copy", async () => {
    const label = await provider.createLabel("Inbox Zero/Newsletter");
    await provider.labelMessage({
      messageId: incoming.id,
      labelId: label.id,
      labelName: label.name,
    });
    await provider.archiveThread(incoming.threadId, user);

    const inbox = await provider.getInboxMessages(50);
    expect(inbox.some((message) => message.subject === subject)).toBe(false);

    const thread = await provider.getThread(incoming.threadId);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].labelIds).toContain(label.id);
  });

  it("marks read and starred", async () => {
    const [message] = await provider.getThreadMessages(incoming.threadId);
    await provider.markReadThread(incoming.threadId, true);
    await provider.markMessagesStarredState([message.id], true);
    const [updated] = await provider.getThreadMessages(incoming.threadId);
    expect(updated.labelIds).not.toContain("UNREAD");
    expect(updated.labelIds).toContain("STARRED");
  });

  it("saves a reply draft and sends a threaded reply", async () => {
    const [message] = await provider.getThreadMessages(incoming.threadId);
    const { draftId } = await provider.draftEmail(
      message,
      { content: "Thanks, a draft." },
      user,
    );
    const drafts = await provider.getDrafts();
    expect(drafts.map((draft) => draft.id)).toContain(draftId);
    expect(await provider.deleteDraft(draftId)).toBe(true);

    await provider.replyToEmail(message, "Thanks, got it.");

    const peerCopy = await waitFor(() =>
      findInInbox(peer, peerPassword, `Re: ${subject}`),
    );
    expect(peerCopy).toContain(`In-Reply-To: ${message.headers["message-id"]}`);

    const thread = await waitFor(async () => {
      const current = await provider.getThread(incoming.threadId);
      return current.messages.length === 2 ? current : undefined;
    });
    expect(provider.isSentMessage(thread.messages[1])).toBe(true);
    expect(decodeThreadId(thread.id)).toBeTruthy();
  });

  it("trashes the thread into the localized trash folder", async () => {
    await provider.trashThread(incoming.threadId, user, "user");
    const { messages } = await provider.searchMessages({
      query: subject,
      folder: "trash",
    });
    expect(messages.length).toBeGreaterThan(0);
  });

  it("pages new mail by UID for the mailbox sync", async () => {
    const first = await provider.getMailboxSyncPage({ limit: 5 });
    expect(first.reset).toBe(false);
    const next = await provider.getMailboxSyncPage({
      limit: 5,
      cursor: first.cursor,
    });
    expect(next.upsertedMessages).toHaveLength(0);
  });
});

async function withClient<T>(
  username: string,
  pass: string,
  fn: (client: ImapFlow) => Promise<T>,
) {
  const client = new ImapFlow({
    host: host || "",
    port: imapPort,
    secure: true,
    auth: { user: username, pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function sendAs(
  from: string,
  pass: string,
  message: { to: string; subject: string; text: string; headers?: object },
) {
  const transport = nodemailer.createTransport({
    host,
    port: smtpPort,
    secure: true,
    auth: { user: from, pass },
  });
  await transport.sendMail({ from, ...message } as never);
  transport.close();
}

async function findInInbox(username: string, pass: string, subject: string) {
  return withClient(username, pass, async (client) => {
    await client.mailboxOpen("INBOX");
    const uids = (await client.search({ subject }, { uid: true })) || [];
    if (!uids.length) return;
    const message = await client.fetchOne(
      String(uids.at(-1)),
      { source: true },
      { uid: true },
    );
    return message ? message.source?.toString("utf8") : undefined;
  });
}

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for mail");
}
