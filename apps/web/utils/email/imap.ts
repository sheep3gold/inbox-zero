import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import { simpleParser } from "mailparser";
import type {
  BulkArchiveResult,
  BulkArchiveThread,
  DraftAttachment,
  DraftAttachmentsResult,
  DraftAttachmentUploadStart,
  EmailFilter,
  EmailFolderCount,
  EmailLabel,
  EmailLabelUpdate,
  EmailProvider,
  EmailSignature,
  EmailThread,
  GetThreadOptions,
  MailboxSyncPage,
  ProviderMailboxSearch,
  SentMessagePage,
} from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { InboxZeroLabel } from "@/utils/label";
import { inboxZeroLabels } from "@/utils/label";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { DraftAttachmentMetadata } from "@/utils/actions/draft-attachments.validation";
import type { LocalMailSyncResponse } from "@/utils/email/local-mail-sync-types";
import type { EmailContact } from "@/utils/email/contact";
import type { SendAsAddress } from "@/utils/email/send-as";
import type { Logger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import {
  convertOutgoingEmailHtmlToText,
  ensureEmailSendingEnabled,
} from "@/utils/mail";
import { createReplyContent } from "@/utils/gmail/reply";
import {
  buildReplyMessageText,
  convertTextToHtmlParagraphs,
  stripHtmlTagsForPlainText,
} from "@/utils/gmail/mail";
import {
  forwardEmailHtml,
  forwardEmailSubject,
  forwardEmailText,
} from "@/utils/gmail/forward";
import { renderReplyBodyHtml } from "@/utils/email/reply-body-html";
import {
  buildReplyAllRecipients,
  formatCcList,
  mergeAndDedupeRecipients,
} from "@/utils/email/reply-all";
import { formatReplySubject } from "@/utils/email/subject";
import { buildThreadingHeaders } from "@/utils/email/threading";
import { getLatestNonDraftMessage } from "@/utils/email/latest-message";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import { extractEmailAddress, getSearchTermForSender } from "@/utils/email";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
} from "@/utils/email/mailbox-sync";
import { type ImapSession, withImapSession } from "@/utils/imap/client";
import {
  type FolderMap,
  findFolderByName,
  getFolderDisplayName,
  getRoleForPath,
  type MailboxRole,
  resolveLabelToPath,
  ROLE_LABEL_IDS,
  STARRED_LABEL_ID,
  toFolderPath,
  UNREAD_LABEL_ID,
} from "@/utils/imap/folder";
import {
  decodeMessageId,
  encodeMessageId,
  encodeThreadId,
  stripAngles,
} from "@/utils/imap/ids";
import {
  copyLocations,
  dedupeCopies,
  deleteLocations,
  fetchLocations,
  fetchMessages,
  fetchRaw,
  findByRfcMessageId,
  findThreadLocations,
  getFolders,
  getSearchFolders,
  locateMessage,
  type MessageFormat,
  type MessageLocation,
  moveLocations,
  searchUids,
  setFlag,
  sortChronologically,
} from "@/utils/imap/mailbox";
import { buildImapSearch, mergeConditions } from "@/utils/imap/search";
import {
  buildMime,
  collectRecipients,
  extractAddress,
  generateMessageId,
} from "@/utils/imap/compose";
import { sendRawSmtpMessage } from "@/utils/imap/smtp";
import {
  type ImapCredentialConfig,
  ImapMessageNotFoundError,
  UnsupportedImapOperationError,
} from "@/utils/imap/types";
import type { SearchObject } from "imapflow";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// Matches to date-sort before paging; beyond this, older matches are dropped.
const MAX_SORT_CANDIDATES = 500;
const POLLING_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_COPY_CHECK_DELAYS_MS = [500, 1500];

type ListOptions = {
  paths: string[];
  search?: SearchObject;
  maxResults?: number;
  pageToken?: string;
  format?: MessageFormat;
  filter?: (message: ParsedMessage) => boolean;
};

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;
  readonly localMailSyncStrategy = "folder-delta" as const;

  // Rule actions run in sequence on one provider: remember which messages a
  // LABEL action filed into a folder, so a later ARCHIVE doesn't leave a
  // second copy in the archive folder.
  private readonly filedThisRun = new Map<string, string>();

  private readonly config: ImapCredentialConfig;
  private readonly logger: Logger;

  constructor(config: ImapCredentialConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  toJSON() {
    return { name: this.name, type: "ImapProvider" };
  }

  getAccessToken(): string {
    return "";
  }

  // ---------------------------------------------------------------- reading

  async getMessage(messageId: string): Promise<ParsedMessage> {
    return this.session(async (session, folders) => {
      const location = await locateMessage(session, folders, messageId);
      const [message] = await fetchMessages(
        session,
        folders,
        location.path,
        [location.uid],
        "full",
      );
      if (!message) throw new ImapMessageNotFoundError(messageId);
      return message;
    });
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    return this.session(async (session, folders) => {
      const locations = await this.locateMany(session, folders, messageIds);
      return fetchLocations(session, folders, locations, "full");
    });
  }

  async getMessageSource(messageId: string): Promise<Buffer> {
    return this.session(async (session, folders) => {
      const location = await locateMessage(session, folders, messageId);
      const [raw] = await fetchRaw(
        session,
        location.path,
        [location.uid],
        "full",
      );
      if (!raw) throw new ImapMessageNotFoundError(messageId);
      return raw.source;
    });
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    return this.session(async (session, folders) => {
      const [location] = await findByRfcMessageId(
        session,
        getSearchFolders(folders, { includeDrafts: true }),
        rfc822MessageId,
      );
      if (!location) return null;
      const [message] = await fetchMessages(session, folders, location.path, [
        location.uid,
      ]);
      return message ?? null;
    });
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessage(originalMessageId).catch(() => null);
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    return this.getMessagesBatch(messageIds);
  }

  async getThread(
    threadId: string,
    options?: GetThreadOptions,
  ): Promise<EmailThread> {
    const messages = await this.getThreadMessagesInternal(threadId, {
      includeDrafts: options?.includeDrafts,
    });
    return toThread(threadId, messages);
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    return this.getThreadMessagesInternal(threadId, {});
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const messages = await this.getThreadMessages(threadId);
    return messages.filter((message) => message.labelIds?.includes("INBOX"));
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    const messages = await this.getThreadMessages(threadId);
    return latestNonDraft(messages);
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    return (
      latestNonDraft(thread.messages) ??
      (await this.getLatestMessageInThread(thread.id))
    );
  }

  async getInboxMessages(maxResults = DEFAULT_PAGE_SIZE) {
    const { messages } = await this.listFolderMessages({
      role: "inbox",
      maxResults,
    });
    return messages;
  }

  async getSentMessages(maxResults = DEFAULT_PAGE_SIZE) {
    const { messages } = await this.listFolderMessages({
      role: "sent",
      maxResults,
    });
    return messages;
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    const { messages, nextPageToken } = await this.listFolderMessages({
      role: "sent",
      maxResults: options.maxResults,
      pageToken: options.pageToken,
      search: dateSearch(options),
      format: "metadata",
    });
    return {
      messages: messages.map(({ id, threadId }) => ({ id, threadId })),
      nextPageToken,
    };
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    folderId?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
    includeDrafts?: boolean;
  }) {
    return this.session(async (session, folders) => {
      const paths = options.folderId
        ? [resolveLabelToPath(folders, options.folderId) ?? options.folderId]
        : options.inboxOnly
          ? [folders.byRole.inbox ?? "INBOX"]
          : getSearchFolders(folders, { includeDrafts: options.includeDrafts });
      return this.listMessages(session, folders, {
        paths,
        search: mergeConditions([
          buildImapSearch(options.query, { gmail: session.isGmail }),
          dateSearch(options),
          ...(options.unreadOnly ? [{ seen: false }] : []),
        ]),
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      });
    });
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }) {
    return this.session(async (session, folders) =>
      this.listMessages(session, folders, {
        paths: getSearchFolders(folders, { includeSent: false }),
        search: mergeConditions([
          { from: options.senderEmail },
          dateSearch(options),
        ]),
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      }),
    );
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }) {
    return this.session(async (session, folders) =>
      this.listMessages(session, folders, {
        paths: getSearchFolders(folders),
        search: { header: { "content-type": "multipart/mixed" } },
        maxResults: options.maxResults,
        pageToken: options.pageToken,
        filter: (message) => !!message.attachments?.length,
      }),
    );
  }

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    fromEmail?: string;
    readState?: "read" | "unread";
    labelName?: string;
    folderId?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    mailboxSearch?: ProviderMailboxSearch;
  }) {
    return this.session(async (session, folders) => {
      const paths = this.resolveSearchPaths(folders, options);
      const mailboxSearch = options.mailboxSearch;
      const readState =
        options.readState ??
        (mailboxSearch?.read === undefined
          ? undefined
          : mailboxSearch.read
            ? "read"
            : "unread");
      return this.listMessages(session, folders, {
        paths,
        search: mergeConditions([
          buildImapSearch(mailboxSearch?.text?.value ?? options.query, {
            gmail: session.isGmail,
          }),
          ...(options.fromEmail ? [{ from: options.fromEmail }] : []),
          ...(readState ? [{ seen: readState === "read" }] : []),
          ...(mailboxSearch?.starred === undefined
            ? []
            : [{ flagged: mailboxSearch.starred }]),
          ...(mailboxSearch?.hasAttachment
            ? [{ header: { "content-type": "multipart/mixed" } }]
            : []),
        ]),
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      });
    });
  }

  async searchThreads(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
    includeSpamTrash?: boolean;
    folder?: "spam" | "trash";
    labelIds?: string[];
  }) {
    const { messages, nextPageToken } = await this.searchMessages(options);
    return { threads: groupIntoThreads(messages), nextPageToken };
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const { threads } = await this.getThreadsWithQuery({
      query: folderId ? { labelId: folderId } : { type: "inbox" },
    });
    return threads;
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { threads } = await this.getThreadsWithQuery({
      query: { labelId: options.labelId },
      maxResults: options.maxResults,
    });
    return threads;
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
  }) {
    const query = options.query ?? ({} as ThreadsQuery);
    return this.session(async (session, folders) => {
      const paths = resolveThreadQueryPaths(folders, query);
      const search = mergeConditions([
        buildImapSearch(query.q ?? undefined, { gmail: session.isGmail }),
        ...(query.fromEmail ? [{ from: query.fromEmail }] : []),
        ...(query.isUnread ? [{ seen: false }] : []),
        ...(query.type === "starred" ? [{ flagged: true }] : []),
        dateSearch({
          after: query.after ?? undefined,
          before: query.before ?? undefined,
        }),
      ]);
      const { messages, nextPageToken } = await this.listMessages(
        session,
        folders,
        {
          paths,
          search,
          maxResults: options.maxResults,
          pageToken: options.pageToken,
          format: options.messageFormat ?? "full",
        },
      );
      return { threads: groupIntoThreads(messages), nextPageToken };
    });
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    return this.session(async (session, folders) => {
      const { messages } = await this.listMessages(session, folders, {
        paths: getSearchFolders(folders),
        search: {
          or: [
            { from: options.participantEmail },
            { to: options.participantEmail },
            { cc: options.participantEmail },
          ],
        },
        maxResults: (options.maxThreads ?? 10) * 3,
      });
      return groupIntoThreads(messages).slice(0, options.maxThreads ?? 10);
    });
  }

  async getThreadsFromSenderWithSubject(sender: string, limit: number) {
    const { messages } = await this.getMessagesFromSender({
      senderEmail: sender,
      maxResults: limit * 2,
    });
    return groupIntoThreads(messages)
      .slice(0, limit)
      .map((thread) => {
        const latest = thread.messages.at(-1);
        return {
          id: thread.id,
          snippet: latest?.snippet ?? "",
          subject: latest?.subject ?? "",
        };
      });
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const excludedTo = new Set(
      (options.excludeToEmails ?? []).map((email) => email.toLowerCase()),
    );
    const excludedFrom = new Set(
      (options.excludeFromEmails ?? []).map((email) => email.toLowerCase()),
    );
    const { messages } = await this.listFolderMessages({
      role: "sent",
      maxResults: (options.maxResults ?? 20) * 2,
      filter: (message) => {
        const to = extractEmailAddress(message.headers.to).toLowerCase();
        const from = extractEmailAddress(message.headers.from).toLowerCase();
        return !excludedTo.has(to) && !excludedFrom.has(from);
      },
    });
    return groupIntoThreads(messages).slice(0, options.maxResults ?? 20);
  }

  async countMessages(options: {
    folderId?: string;
    labelId?: string;
  }): Promise<number> {
    return this.session(async (session, folders) => {
      const scope = options.folderId ?? options.labelId;
      const paths = scope
        ? [resolveLabelToPath(folders, scope) ?? scope]
        : getSearchFolders(folders, { includeDrafts: true });
      let total = 0;
      for (const path of paths) {
        const status = await session.client.status(path, { messages: true });
        total += status ? (status.messages ?? 0) : 0;
      }
      return total;
    });
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    return this.session(async (session, folders) => {
      let count = 0;
      for (const path of getSearchFolders(folders, { includeSent: false })) {
        count += (await searchUids(session, path, { from: senderEmail }))
          .length;
        if (count >= threshold) break;
      }
      return count;
    });
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    return this.session(async (session, folders) => {
      const sent = folders.byRole.sent;
      if (!sent) return false;
      const uids = await searchUids(session, sent, { to: senderEmail });
      return uids.length > 0;
    });
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const term = getSearchTermForSender(options.from);
    return this.session(async (session, folders) => {
      const before = { before: options.date };
      const sent = folders.byRole.sent;
      if (sent) {
        const uids = await searchUids(session, sent, { to: term, ...before });
        if (uids.length) return true;
      }
      const current = decodeMessageId(options.messageId);
      for (const path of getSearchFolders(folders, { includeSent: false })) {
        const uids = (
          await searchUids(session, path, { from: term, ...before })
        ).filter((uid) => !(current?.mailbox === path && current.uid === uid));
        if (uids.length) return true;
      }
      return false;
    });
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    return this.session(async (session, folders) => {
      const status = await session.client.status(
        folders.byRole.inbox ?? "INBOX",
        { messages: true, unseen: true },
      );
      if (!status) return { total: 0, unread: 0 };
      return { total: status.messages ?? 0, unread: status.unseen ?? 0 };
    });
  }

  async getFolderCounts(): Promise<EmailFolderCount[]> {
    return this.session(async (session, folders) => {
      const counts: EmailFolderCount[] = [];
      for (const mailbox of folders.selectable) {
        const status = await session.client
          .status(mailbox.path, { messages: true, unseen: true })
          .catch(() => false as const);
        if (!status) continue;
        counts.push({
          id: mailbox.path,
          name: getFolderDisplayName(mailbox.path, folders.delimiter),
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
          systemType: toSystemType(getRoleForPath(folders, mailbox.path)),
        });
      }
      return counts;
    });
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const content = await this.getAttachmentContent(messageId, attachmentId);
    return { data: content.toString("base64url"), size: content.length };
  }

  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const content = await this.getAttachmentContent(messageId, attachmentId);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(content));
        controller.close();
      },
    });
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return !!(message.headers["in-reply-to"] || message.headers.references);
  }

  isSentMessage(message: ParsedMessage): boolean {
    return message.labelIds?.includes("SENT") ?? false;
  }

  // ------------------------------------------------------------- labels

  async getLabels(options?: {
    includeHidden?: boolean;
  }): Promise<EmailLabel[]> {
    return this.session(async (_session, folders) =>
      folders.selectable
        .filter(
          (mailbox) =>
            options?.includeHidden || mailbox.path !== folders.byRole.all,
        )
        .map((mailbox) => toLabel(folders, mailbox.path)),
    );
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    return this.session(async (_session, folders) => {
      const path = resolveLabelToPath(folders, labelId);
      return path ? toLabel(folders, path) : null;
    });
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    return this.session(async (_session, folders) => {
      const mailbox = findFolderByName(folders, name);
      return mailbox ? toLabel(folders, mailbox.path) : null;
    });
  }

  async createLabel(name: string): Promise<EmailLabel> {
    return this.session(async (session, folders) => {
      const path = await this.ensureFolder(session, folders, name);
      return toLabel(await getFolders(session), path);
    });
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    return this.createLabel(inboxZeroLabels[key].name);
  }

  async updateLabel(labelId: string, update: EmailLabelUpdate): Promise<void> {
    // Folder colors and visibility have no IMAP equivalent.
    if (update.name) await this.renameFolder(labelId, update.name);
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.deleteFolder(labelId);
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    return this.session(async (session, folders) => {
      const location = await locateMessage(session, folders, options.messageId);
      if (
        await this.applySystemLabel(
          session,
          folders,
          [location],
          options.labelId,
        )
      ) {
        return {};
      }

      let path = resolveLabelToPath(folders, options.labelId);
      let usedFallback = false;
      if (!path) {
        if (!options.labelName) {
          throw new SafeError(`Folder ${options.labelId} no longer exists`);
        }
        path = await this.ensureFolder(session, folders, options.labelName);
        usedFallback = true;
      }

      // Copying keeps the message where it is. On Gmail a copy is exactly
      // "add label"; elsewhere the folder gets its own copy.
      await copyLocations(session, [location], path);
      if (location.rfcMessageId) {
        this.filedThisRun.set(location.rfcMessageId, path);
      }
      return usedFallback ? { usedFallback, actualLabelId: path } : {};
    });
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    await this.removeThreadLabels(threadId, [labelId]);
  }

  async removeThreadLabels(
    threadId: string,
    labelIds: string[],
  ): Promise<void> {
    if (!labelIds.length) return;
    await this.session(async (session, folders) => {
      for (const labelId of labelIds) {
        if (labelId === UNREAD_LABEL_ID || labelId === STARRED_LABEL_ID) {
          const locations = await findThreadLocations(
            session,
            getSearchFolders(folders),
            threadId,
          );
          await setFlag(
            session,
            locations,
            labelId === UNREAD_LABEL_ID ? "\\Seen" : "\\Flagged",
            labelId === UNREAD_LABEL_ID,
          );
          continue;
        }
        if (labelId === ROLE_LABEL_IDS.inbox) {
          await this.archiveThreadInSession(session, folders, threadId);
          continue;
        }

        const path = resolveLabelToPath(folders, labelId);
        if (!path || getRoleForPath(folders, path)) continue;
        await this.removeFromFolder(session, folders, threadId, path);
      }
    });
  }

  async getFolders(): Promise<OutlookFolder[]> {
    return this.session(async (_session, folders) => buildFolderTree(folders));
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    return this.session((session, folders) =>
      this.ensureFolder(session, folders, folderName),
    );
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.session(async (session, folders) => {
      if (getRoleForPath(folders, folderId)) {
        throw new SafeError("System folders can't be renamed");
      }
      await session.client.mailboxRename(
        folderId,
        toFolderPath(name, folders.delimiter),
      );
      session.invalidateMailboxes();
    });
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.session(async (session, folders) => {
      if (getRoleForPath(folders, folderId)) {
        throw new SafeError("System folders can't be deleted");
      }
      await session.client.mailboxDelete(folderId);
      session.invalidateMailboxes();
    });
  }

  // ------------------------------------------------------------- moving

  async archiveThread(threadId: string, _ownerEmail: string): Promise<void> {
    await this.session((session, folders) =>
      this.archiveThreadInSession(session, folders, threadId),
    );
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    await this.session(async (session, folders) => {
      const destination = labelId
        ? resolveLabelToPath(folders, labelId)
        : undefined;
      if (!destination) {
        await this.archiveThreadInSession(session, folders, threadId);
        return;
      }
      const locations = await findThreadLocations(
        session,
        [folders.byRole.inbox ?? "INBOX"],
        threadId,
      );
      await moveLocations(session, locations, destination);
    });
  }

  async archiveMessage(messageId: string): Promise<void> {
    await this.archiveMessages([messageId]);
  }

  async archiveMessages(messageIds: string[], labelId?: string): Promise<void> {
    await this.session(async (session, folders) => {
      const locations = (
        await this.locateMany(session, folders, messageIds)
      ).filter((location) => location.path === folders.byRole.inbox);
      const destination = labelId
        ? resolveLabelToPath(folders, labelId)
        : undefined;
      if (destination) {
        await moveLocations(session, locations, destination);
      } else {
        await this.archiveLocations(session, folders, locations);
      }
    });
  }

  async bulkArchiveThreads(
    threads: BulkArchiveThread[],
    _ownerEmail: string,
  ): Promise<BulkArchiveResult> {
    const result: BulkArchiveResult = {
      succeededThreadIds: [],
      failedThreadIds: [],
    };
    await this.session(async (session, folders) => {
      for (const thread of threads) {
        try {
          const locations = thread.messageIds.length
            ? await this.locateMany(session, folders, thread.messageIds)
            : await findThreadLocations(
                session,
                [folders.byRole.inbox ?? "INBOX"],
                thread.threadId,
              );
          await this.archiveLocations(
            session,
            folders,
            locations.filter(
              (location) => location.path === folders.byRole.inbox,
            ),
          );
          result.succeededThreadIds.push(thread.threadId);
        } catch (error) {
          this.logger.warn("Failed to archive IMAP thread", { error });
          result.failedThreadIds.push(thread.threadId);
        }
      }
    });
    return result;
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    for (const fromEmail of fromEmails) {
      await this.moveSenderMessages(fromEmail, "archive").catch((error) => {
        this.logger.warn("Failed to archive sender", { error });
      });
    }
  }

  async bulkArchiveSenderOrThrow(
    fromEmail: string,
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<number> {
    return this.moveSenderMessages(fromEmail, "archive");
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    for (const fromEmail of fromEmails) {
      await this.moveSenderMessages(fromEmail, "trash").catch((error) => {
        this.logger.warn("Failed to trash sender", { error });
      });
    }
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    await this.archiveMessages([messageId]);
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    await this.session(async (session, folders) => {
      const destination =
        resolveLabelToPath(folders, folderName) ??
        (await this.ensureFolder(session, folders, folderName));
      const locations = await findThreadLocations(
        session,
        [folders.byRole.inbox ?? "INBOX"],
        threadId,
      );
      await moveLocations(session, locations, destination);
    });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.session(async (session, folders) => {
      const locations = await findThreadLocations(
        session,
        getSearchFolders(folders),
        threadId,
      );
      await this.restoreToInbox(session, folders, locations);
    });
  }

  async unarchiveMessages(messageIds: string[]): Promise<void> {
    await this.session(async (session, folders) => {
      const locations = await this.locateMany(session, folders, messageIds);
      await this.restoreToInbox(session, folders, locations);
    });
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    await this.session(async (session, folders) => {
      const trash = await this.requireRole(session, folders, "trash");
      const locations = await findThreadLocations(
        session,
        getSearchFolders(folders, { includeDrafts: true }),
        threadId,
      );
      await this.moveAllCopies(session, folders, locations, trash);
    });
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    await this.session(async (session, folders) => {
      const trash = await this.requireRole(session, folders, "trash");
      const locations = await this.locateMany(session, folders, messageIds);
      await this.moveAllCopies(session, folders, locations, trash);
    });
  }

  async untrashThread(threadId: string): Promise<void> {
    await this.session(async (session, folders) => {
      const trash = folders.byRole.trash;
      if (!trash) return;
      const locations = await findThreadLocations(session, [trash], threadId);
      await moveLocations(session, locations, folders.byRole.inbox ?? "INBOX");
    });
  }

  async untrashMessages(messageIds: string[]): Promise<void> {
    await this.session(async (session, folders) => {
      const locations = (
        await this.locateMany(session, folders, messageIds)
      ).filter((location) => location.path === folders.byRole.trash);
      await moveLocations(session, locations, folders.byRole.inbox ?? "INBOX");
    });
  }

  async markSpam(threadId: string): Promise<void> {
    await this.session(async (session, folders) => {
      const junk = await this.requireRole(session, folders, "junk");
      const locations = await findThreadLocations(
        session,
        getSearchFolders(folders),
        threadId,
      );
      await this.moveAllCopies(session, folders, locations, junk);
    });
  }

  async markNotSpam(threadId: string): Promise<void> {
    await this.session(async (session, folders) => {
      const junk = folders.byRole.junk;
      if (!junk) return;
      const locations = await findThreadLocations(session, [junk], threadId);
      await moveLocations(session, locations, folders.byRole.inbox ?? "INBOX");
    });
  }

  // -------------------------------------------------------------- flags

  async markRead(threadId: string): Promise<void> {
    await this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    await this.session(async (session, folders) => {
      const locations = await findThreadLocations(
        session,
        getSearchFolders(folders),
        threadId,
      );
      await setFlag(session, locations, "\\Seen", read);
    });
  }

  async markMessagesReadState(messageIds: string[], read: boolean) {
    await this.session(async (session, folders) => {
      const locations = await this.locateMany(session, folders, messageIds);
      await setFlag(session, locations, "\\Seen", read);
    });
  }

  async starMessage(messageId: string): Promise<void> {
    await this.markMessagesStarredState([messageId], true);
  }

  async markMessagesStarredState(messageIds: string[], starred: boolean) {
    await this.session(async (session, folders) => {
      const locations = await this.locateMany(session, folders, messageIds);
      await setFlag(session, locations, "\\Flagged", starred);
    });
  }

  // ------------------------------------------------------------- drafts

  async createDraft(params: {
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
    forwardedMessageId?: string;
  }): Promise<{ id: string }> {
    const replyTo = params.replyToMessageId
      ? await this.getMessage(params.replyToMessageId)
      : undefined;
    const forwarded = params.forwardedMessageId
      ? await this.getMessageAttachments(params.forwardedMessageId)
      : [];
    const raw = await this.composeMessage({
      to: params.to,
      from: params.from,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      html: params.messageHtml,
      attachments: forwarded,
      inReplyTo: replyTo,
    });
    const id = await this.appendDraft(raw.mime, raw.messageId);
    return { id };
  }

  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    userEmail: string,
  ): Promise<{ draftId: string }> {
    const { html } = createReplyContent({
      textContent: args.content,
      htmlContent: renderReplyBodyHtml(args.content),
      message: email,
    });
    const text = buildReplyMessageText({
      textContent: args.content,
      message: email,
    });
    const recipients = buildReplyAllRecipients(
      email.headers,
      args.to,
      userEmail,
    );
    const cc = mergeAndDedupeRecipients(recipients.cc, args.cc);
    const bcc = mergeAndDedupeRecipients([], args.bcc);

    const raw = await this.composeMessage({
      to: recipients.to,
      cc: formatCcList(cc),
      bcc: formatCcList(bcc),
      subject: args.subject || formatReplySubject(email.headers.subject),
      html,
      text,
      attachments: args.attachments,
      inReplyTo: email,
    });
    const draftId = await this.appendDraft(raw.mime, raw.messageId);
    return { draftId };
  }

  async getDraft(
    draftId: string,
    _options?: { includeAttachments?: boolean },
  ): Promise<ParsedMessage | null> {
    return this.getMessage(draftId).catch((error) => {
      if (error instanceof ImapMessageNotFoundError) return null;
      throw error;
    });
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const { messages } = await this.listFolderMessages({
      role: "drafts",
      maxResults: options?.maxResults,
    });
    return messages;
  }

  async getDraftReferenceForMessage(messageId: string) {
    return this.session(async (session, folders) => {
      const location = await locateMessage(session, folders, messageId).catch(
        () => null,
      );
      if (!location || location.path !== folders.byRole.drafts) return null;
      return { id: messageId };
    });
  }

  async updateDraft(
    draftId: string,
    params: {
      messageHtml?: string;
      subject?: string;
      to?: string;
      from?: string;
      cc?: string;
      bcc?: string;
    },
  ): Promise<void> {
    await this.rewriteDraft(draftId, (draft) => ({
      ...draft,
      ...(params.to !== undefined && { to: params.to }),
      ...(params.from !== undefined && { from: params.from }),
      ...(params.cc !== undefined && { cc: params.cc }),
      ...(params.bcc !== undefined && { bcc: params.bcc }),
      ...(params.subject !== undefined && { subject: params.subject }),
      ...(params.messageHtml !== undefined && {
        html: params.messageHtml,
        text: htmlToText(params.messageHtml),
      }),
    }));
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    return this.session(async (session, folders) => {
      const location = await locateMessage(session, folders, draftId).catch(
        () => null,
      );
      if (!location) return false;
      await deleteLocations(session, [location]);
      return true;
    });
  }

  async sendDraft(draftId: string) {
    ensureEmailSendingEnabled();
    const draft = await this.readDraftParts(draftId);
    const result = await this.sendComposed({
      ...draft,
      messageId: draft.messageId,
    });
    await this.deleteDraft(draftId);
    return result;
  }

  async getDraftAttachments(
    draftId: string,
  ): Promise<DraftAttachmentsResult | null> {
    const draft = await this.readDraftParts(draftId).catch((error) => {
      if (error instanceof ImapMessageNotFoundError) return null;
      throw error;
    });
    if (!draft) return null;
    return {
      messageId: draftId,
      attachments: toDraftAttachments(draftId, draft.attachments),
    };
  }

  async addDraftAttachment(
    draftId: string,
    attachment: DraftAttachmentMetadata & { content: Buffer },
  ): Promise<DraftAttachmentsResult & { attachmentId: string }> {
    const newId = await this.rewriteDraft(draftId, (draft) => ({
      ...draft,
      attachments: [
        ...draft.attachments,
        {
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.mimeType,
          contentDisposition: attachment.disposition,
          ...(attachment.contentId && { cid: attachment.contentId }),
          headers: { "X-Attachment-Id": attachment.id },
        },
      ],
    }));
    const result = await this.getDraftAttachments(newId);
    return {
      messageId: newId,
      attachments: result?.attachments ?? [],
      attachmentId: attachment.id,
    };
  }

  async removeDraftAttachment(
    draftId: string,
    attachmentId: string,
  ): Promise<DraftAttachmentsResult> {
    const newId = await this.rewriteDraft(draftId, (draft) => ({
      ...draft,
      attachments: draft.attachments.filter(
        (item, index) => attachmentKey(item, index) !== attachmentId,
      ),
    }));
    const result = await this.getDraftAttachments(newId);
    return { messageId: newId, attachments: result?.attachments ?? [] };
  }

  async startDraftAttachmentUpload(
    _draftId: string,
    _attachment: DraftAttachmentMetadata,
  ): Promise<DraftAttachmentUploadStart> {
    throw new SafeError(
      "Large attachment uploads aren't available for IMAP accounts. Attach a smaller file.",
    );
  }

  // ------------------------------------------------------------- sending

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<{ messageId: string }> {
    ensureEmailSendingEnabled();
    const { messageId } = await this.sendComposed({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      html: convertTextToHtmlParagraphs(args.messageText),
      attachments: args.attachments ?? [],
    });
    return { messageId };
  }

  async sendEmailWithHtml(
    body: Omit<SendEmailBody, "attachments"> & {
      attachments?: MailAttachment[] | SendEmailBody["attachments"];
    },
  ): Promise<{ messageId: string; threadId: string }> {
    ensureEmailSendingEnabled();
    const forwarded = body.replyToEmail?.forwardedMessageId
      ? await this.getMessageAttachments(body.replyToEmail.forwardedMessageId)
      : [];
    const attachments = [
      ...((body.attachments ?? []) as MailAttachment[]),
      ...forwarded,
    ];
    const result = await this.sendComposed({
      to: body.to,
      from: body.from,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      text: htmlToText(body.messageHtml),
      attachments,
      threading: body.replyToEmail?.headerMessageId
        ? buildThreadingHeaders({
            headerMessageId: body.replyToEmail.headerMessageId,
            references: body.replyToEmail.references,
          })
        : undefined,
      threadId: body.replyToEmail?.threadId,
    });
    if (body.providerDraftId) {
      await this.deleteDraft(body.providerDraftId).catch((error) => {
        this.logger.warn("Failed to delete sent IMAP draft", { error });
      });
    }
    return result;
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<{ messageId: string }> {
    ensureEmailSendingEnabled();
    const { html } = createReplyContent({
      textContent: content,
      htmlContent: renderReplyBodyHtml(content),
      message: email,
    });
    const text = buildReplyMessageText({
      textContent: content,
      message: email,
    });
    const { messageId } = await this.sendComposed({
      to: email.headers["reply-to"] || email.headers.from,
      from: options?.from,
      cc: options?.cc,
      bcc: options?.bcc,
      replyTo: options?.replyTo,
      subject: formatReplySubject(email.headers.subject),
      html,
      text,
      attachments: options?.attachments ?? [],
      inReplyTo: email,
    });
    return { messageId };
  }

  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<{ messageId: string }> {
    ensureEmailSendingEnabled();
    if (!args.to?.trim()) {
      throw new Error("Recipient address is required for forwarding email.");
    }
    const attachments = await this.getMessageAttachments(email.id);
    const { messageId } = await this.sendComposed({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      from: args.from,
      subject: forwardEmailSubject(email.headers.subject),
      html: forwardEmailHtml({ content: args.content ?? "", message: email }),
      text: forwardEmailText({ content: args.content ?? "", message: email }),
      attachments,
    });
    return { messageId };
  }

  // --------------------------------------------------- unsupported / no-op

  async getFiltersList(): Promise<EmailFilter[]> {
    // IMAP has no portable server-side filters. Auto-archive is enforced by
    // the poller from the sender's stored status instead.
    return [];
  }

  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    throw new UnsupportedImapOperationError("createFilter");
  }

  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    return { status: 200 };
  }

  async deleteFilter(_id: string): Promise<{ status: number }> {
    return { status: 200 };
  }

  async getSignatures(): Promise<EmailSignature[]> {
    return [];
  }

  async getSendAsAddresses(): Promise<SendAsAddress[]> {
    return [];
  }

  async getForwardingAddresses(): Promise<string[]> {
    return [];
  }

  async getContactPhotos(): Promise<Record<string, string>> {
    return {};
  }

  async searchContacts(_query: string): Promise<EmailContact[]> {
    return [];
  }

  async watchEmails() {
    // New mail is found by polling (/api/imap/poll); the lease only tells the
    // rest of the app that automation is active for this account.
    return { expirationDate: new Date(Date.now() + POLLING_LEASE_MS) };
  }

  async unwatchEmails(_subscriptionId?: string): Promise<void> {}

  async syncLocalMail(): Promise<LocalMailSyncResponse> {
    return { status: "unsupported", strategy: this.localMailSyncStrategy };
  }

  /**
   * Snapshot then delta by UID for one folder. IMAP can't report deletions
   * cheaply without QRESYNC, so a UIDVALIDITY change resets the sync instead.
   */
  async getMailboxSyncPage(options: {
    after?: Date;
    cursor?: string;
    folderId?: string;
    limit: number;
  }): Promise<MailboxSyncPage> {
    return this.session(async (session, folders) => {
      const previous = options.cursor
        ? decodeMailboxSyncCursor(options.cursor, "imap")
        : undefined;
      const path =
        previous?.folder ??
        (options.folderId
          ? (resolveLabelToPath(folders, options.folderId) ?? options.folderId)
          : (folders.byRole.inbox ?? "INBOX"));
      const after =
        previous?.after ??
        (options.after ?? new Date(Date.now() - 30 * 86_400_000)).toISOString();

      const { uidValidity, uids } = await session.withMailbox(
        path,
        async (mailbox) => {
          const sameValidity =
            previous && previous.uidValidity === String(mailbox.uidValidity);
          const query: SearchObject = sameValidity
            ? { uid: `${previous.lastUid + 1}:*` }
            : { since: new Date(after) };
          const found =
            (await session.client.search(query, { uid: true })) || [];
          return {
            uidValidity: String(mailbox.uidValidity),
            uids: found
              .filter((uid) => !sameValidity || uid > previous.lastUid)
              .sort((a, b) => a - b),
          };
        },
        { readOnly: true },
      );

      const reset = !!previous && previous.uidValidity !== uidValidity;
      const page = uids.slice(0, options.limit);
      const messages = await fetchMessages(session, folders, path, page);
      const lastUid = page.at(-1) ?? (reset ? 0 : (previous?.lastUid ?? 0));

      return {
        cursor: encodeMailboxSyncCursor({
          version: 1,
          provider: "imap",
          folder: path,
          uidValidity,
          lastUid,
          after,
        }),
        deletedMessageIds: [],
        hasMore: uids.length > page.length,
        reset,
        upsertedMessages: messages,
      };
    });
  }

  // ------------------------------------------------------------ internals

  private async session<T>(
    fn: (session: ImapSession, folders: FolderMap) => Promise<T>,
  ): Promise<T> {
    return withImapSession(this.config, async (session) =>
      fn(session, await getFolders(session)),
    );
  }

  private async locateMany(
    session: ImapSession,
    folders: FolderMap,
    messageIds: string[],
  ): Promise<MessageLocation[]> {
    const locations: MessageLocation[] = [];
    for (const messageId of messageIds) {
      try {
        locations.push(await locateMessage(session, folders, messageId));
      } catch (error) {
        if (!(error instanceof ImapMessageNotFoundError)) throw error;
        this.logger.info("IMAP message not found, skipping");
      }
    }
    return locations;
  }

  private async getThreadMessagesInternal(
    threadId: string,
    { includeDrafts }: { includeDrafts?: boolean },
  ): Promise<ParsedMessage[]> {
    return this.session(async (session, folders) => {
      const locations = await findThreadLocations(
        session,
        getSearchFolders(folders, { includeDrafts: true }),
        threadId,
      );
      const messages = (
        await fetchLocations(session, folders, locations, "full")
      ).filter(
        (message) =>
          message.threadId === threadId &&
          (includeDrafts || !message.labelIds?.includes("DRAFT")),
      );
      return sortChronologically(messages);
    });
  }

  /** Lists matches across folders newest first, paging by offset. */
  private async listMessages(
    session: ImapSession,
    folders: FolderMap,
    options: ListOptions,
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const pageSize = Math.min(
      options.maxResults ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const offset = decodePageToken(options.pageToken);
    const search = options.search ?? { all: true };

    const candidates: Array<MessageLocation & { time: number }> = [];
    for (const path of options.paths) {
      const uids = (await searchUids(session, path, search)).slice(
        0,
        MAX_SORT_CANDIDATES,
      );
      if (!uids.length) continue;
      if (options.paths.length === 1) {
        // UIDs grow with arrival time, so one folder needs no date fetch.
        candidates.push(...uids.map((uid) => ({ path, uid, time: uid })));
        continue;
      }
      const dates = await this.fetchInternalDates(session, path, uids);
      candidates.push(
        ...uids.map((uid) => ({ path, uid, time: dates.get(uid) ?? 0 })),
      );
    }
    candidates.sort((a, b) => b.time - a.time);

    const messages: ParsedMessage[] = [];
    let cursor = offset;
    while (messages.length < pageSize && cursor < candidates.length) {
      const slice = candidates.slice(cursor, cursor + pageSize);
      cursor += slice.length;
      const fetched = await fetchLocations(
        session,
        folders,
        slice,
        options.format ?? "full",
      );
      const order = new Map(
        slice.map((candidate, index) => [
          `${candidate.path}\u0000${candidate.uid}`,
          index,
        ]),
      );
      fetched.sort(
        (a, b) =>
          (order.get(`${a.parentFolderId}\u0000${a.historyId}`) ?? 0) -
          (order.get(`${b.parentFolderId}\u0000${b.historyId}`) ?? 0),
      );
      messages.push(
        ...(options.filter ? fetched.filter(options.filter) : fetched),
      );
    }

    return {
      messages: dedupeCopies(messages, folders).slice(0, pageSize),
      nextPageToken:
        cursor < candidates.length ? encodePageToken(cursor) : undefined,
    };
  }

  private async listFolderMessages({
    role,
    ...options
  }: Omit<ListOptions, "paths"> & { role: MailboxRole }) {
    return this.session(async (session, folders) => {
      const path = folders.byRole[role];
      if (!path) return { messages: [] as ParsedMessage[] };
      return this.listMessages(session, folders, { ...options, paths: [path] });
    });
  }

  private async fetchInternalDates(
    session: ImapSession,
    path: string,
    uids: number[],
  ) {
    return session.withMailbox(
      path,
      async () => {
        const dates = new Map<number, number>();
        for await (const message of session.client.fetch(
          uids.join(","),
          { uid: true, internalDate: true },
          { uid: true },
        )) {
          const date = message.internalDate
            ? new Date(message.internalDate).getTime()
            : 0;
          dates.set(message.uid, date);
        }
        return dates;
      },
      { readOnly: true },
    );
  }

  private resolveSearchPaths(
    folders: FolderMap,
    options: {
      labelName?: string;
      folderId?: string;
      labelIds?: string[];
      includeSpamTrash?: boolean;
      folder?: "spam" | "trash";
      mailboxSearch?: ProviderMailboxSearch;
    },
  ): string[] {
    if (options.folder) {
      const path = folders.byRole[options.folder === "spam" ? "junk" : "trash"];
      return path ? [path] : [];
    }
    if (options.folderId) {
      return [
        resolveLabelToPath(folders, options.folderId) ?? options.folderId,
      ];
    }
    if (options.labelName) {
      const mailbox = findFolderByName(folders, options.labelName);
      return mailbox ? [mailbox.path] : [];
    }
    const labelPath = options.labelIds
      ?.map((labelId) => resolveLabelToPath(folders, labelId))
      .find(Boolean);
    if (labelPath) return [labelPath];

    const mailbox = options.mailboxSearch?.mailbox;
    const roleByMailbox: Partial<Record<string, MailboxRole>> = {
      inbox: "inbox",
      sent: "sent",
      drafts: "drafts",
      spam: "junk",
      trash: "trash",
    };
    const role = mailbox ? roleByMailbox[mailbox] : undefined;
    if (role) {
      const path = folders.byRole[role];
      return path ? [path] : [];
    }
    if (mailbox === "archive") {
      const path = folders.byRole.archive ?? folders.byRole.all;
      return path ? [path] : [];
    }

    return getSearchFolders(folders, {
      includeSpamTrash: options.includeSpamTrash,
    });
  }

  private async ensureFolder(
    session: ImapSession,
    folders: FolderMap,
    name: string,
  ): Promise<string> {
    const existing = findFolderByName(folders, name);
    if (existing) return existing.path;
    const path = toFolderPath(name, folders.delimiter);
    if (!path) throw new SafeError("Folder name is empty");
    try {
      const created = await session.client.mailboxCreate(path);
      await session.client.mailboxSubscribe(created.path).catch(() => false);
      return created.path;
    } finally {
      session.invalidateMailboxes();
    }
  }

  private async requireRole(
    session: ImapSession,
    folders: FolderMap,
    role: "trash" | "junk" | "archive",
  ): Promise<string> {
    const path = folders.byRole[role];
    if (path) return path;
    if (role === "archive" && folders.byRole.all) return folders.byRole.all;
    // QQ and NetEase have no archive folder; create one rather than fail.
    const names = { trash: "Trash", junk: "Junk", archive: "Archive" };
    return this.ensureFolder(session, folders, names[role]);
  }

  private async archiveThreadInSession(
    session: ImapSession,
    folders: FolderMap,
    threadId: string,
  ) {
    const locations = await findThreadLocations(
      session,
      [folders.byRole.inbox ?? "INBOX"],
      threadId,
    );
    await this.archiveLocations(session, folders, locations);
  }

  private async archiveLocations(
    session: ImapSession,
    folders: FolderMap,
    locations: MessageLocation[],
  ) {
    if (!locations.length) return;
    const withRfcIds = await this.withRfcIds(session, folders, locations);
    const filed = withRfcIds.filter(
      (location) =>
        !session.isGmail &&
        location.rfcMessageId &&
        this.filedThisRun.has(location.rfcMessageId),
    );
    const rest = withRfcIds.filter((location) => !filed.includes(location));

    // The folder copy from LABEL is the archived copy; drop the inbox one.
    await deleteLocations(session, filed);
    if (rest.length) {
      const archive = await this.requireRole(session, folders, "archive");
      await moveLocations(session, rest, archive);
    }
  }

  private async restoreToInbox(
    session: ImapSession,
    folders: FolderMap,
    locations: MessageLocation[],
  ) {
    const inbox = folders.byRole.inbox ?? "INBOX";
    const notInInbox = locations.filter((location) => location.path !== inbox);
    if (session.isGmail) {
      // Copying into INBOX adds the label without touching the other labels.
      await copyLocations(session, notInInbox, inbox);
      return;
    }
    const archive = folders.byRole.archive;
    await moveLocations(
      session,
      notInInbox.filter((location) => !archive || location.path === archive),
      inbox,
    );
  }

  /** Trash and spam remove every copy, so no folder keeps showing the message. */
  private async moveAllCopies(
    session: ImapSession,
    folders: FolderMap,
    locations: MessageLocation[],
    destination: string,
  ) {
    if (session.isGmail) {
      await moveLocations(session, locations, destination);
      return;
    }
    const withRfcIds = await this.withRfcIds(session, folders, locations);
    const seen = new Set<string>();
    const primary: MessageLocation[] = [];
    const duplicates: MessageLocation[] = [];
    for (const location of withRfcIds) {
      const key = location.rfcMessageId ?? `${location.path}:${location.uid}`;
      if (seen.has(key)) duplicates.push(location);
      else {
        seen.add(key);
        primary.push(location);
      }
    }
    await moveLocations(session, primary, destination);
    await deleteLocations(
      session,
      duplicates.filter((location) => location.path !== destination),
    );
  }

  private async removeFromFolder(
    session: ImapSession,
    folders: FolderMap,
    threadId: string,
    path: string,
  ) {
    const inFolder = await findThreadLocations(session, [path], threadId);
    if (!inFolder.length) return;
    if (session.isGmail) {
      await deleteLocations(session, inFolder);
      return;
    }
    // Deleting the folder copy is only safe when another copy exists;
    // otherwise move the message to the archive so it isn't lost.
    const otherPaths = getSearchFolders(folders).filter(
      (other) => other !== path,
    );
    const otherCopies = await findThreadLocations(
      session,
      otherPaths,
      threadId,
    );
    const elsewhere = new Set(
      (await fetchLocations(session, folders, otherCopies, "metadata")).map(
        (message) => message.headers["message-id"],
      ),
    );
    const withRfcIds = await this.withRfcIds(session, folders, inFolder);
    const copies = withRfcIds.filter(
      (location) =>
        location.rfcMessageId &&
        elsewhere.has(`<${stripAngles(location.rfcMessageId)}>`),
    );
    const onlyCopies = withRfcIds.filter(
      (location) => !copies.includes(location),
    );
    await deleteLocations(session, copies);
    if (onlyCopies.length) {
      const archive = await this.requireRole(session, folders, "archive");
      await moveLocations(session, onlyCopies, archive);
    }
  }

  private async withRfcIds(
    session: ImapSession,
    folders: FolderMap,
    locations: MessageLocation[],
  ): Promise<MessageLocation[]> {
    const missing = locations.filter((location) => !location.rfcMessageId);
    if (!missing.length) return locations;
    const messages = await Promise.all(
      [...groupPaths(missing)].map(([path, uids]) =>
        fetchMessages(session, folders, path, uids, "metadata"),
      ),
    );
    const ids = new Map<string, string>();
    for (const message of messages.flat()) {
      const ref = decodeMessageId(message.id);
      if (ref?.rfcMessageId)
        ids.set(`${ref.mailbox}:${ref.uid}`, ref.rfcMessageId);
    }
    return locations.map((location) => ({
      ...location,
      rfcMessageId:
        location.rfcMessageId ?? ids.get(`${location.path}:${location.uid}`),
    }));
  }

  private async applySystemLabel(
    session: ImapSession,
    folders: FolderMap,
    locations: MessageLocation[],
    labelId: string,
  ): Promise<boolean> {
    switch (labelId) {
      case UNREAD_LABEL_ID:
        await setFlag(session, locations, "\\Seen", false);
        return true;
      case STARRED_LABEL_ID:
        await setFlag(session, locations, "\\Flagged", true);
        return true;
      case ROLE_LABEL_IDS.inbox:
        await this.restoreToInbox(session, folders, locations);
        return true;
      case ROLE_LABEL_IDS.junk:
        await this.moveAllCopies(
          session,
          folders,
          locations,
          await this.requireRole(session, folders, "junk"),
        );
        return true;
      case ROLE_LABEL_IDS.trash:
        await this.moveAllCopies(
          session,
          folders,
          locations,
          await this.requireRole(session, folders, "trash"),
        );
        return true;
      case ROLE_LABEL_IDS.important:
      case ROLE_LABEL_IDS.sent:
      case ROLE_LABEL_IDS.drafts:
        return true;
      default:
        return false;
    }
  }

  private async moveSenderMessages(
    fromEmail: string,
    action: "archive" | "trash",
  ): Promise<number> {
    return this.session(async (session, folders) => {
      const inbox = folders.byRole.inbox ?? "INBOX";
      const uids = await searchUids(session, inbox, { from: fromEmail });
      if (!uids.length) return 0;
      const locations = uids.map((uid) => ({ path: inbox, uid }));
      if (action === "archive") {
        await this.archiveLocations(session, folders, locations);
      } else {
        await moveLocations(
          session,
          locations,
          await this.requireRole(session, folders, "trash"),
        );
      }
      return uids.length;
    });
  }

  private async getAttachmentContent(
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const source = await this.getMessageSource(messageId);
    const parsed = await simpleParser(source);
    const attachment = parsed.attachments[Number(attachmentId)];
    if (!attachment) throw new SafeError("Attachment not found");
    return attachment.content;
  }

  private async getMessageAttachments(
    messageId: string,
  ): Promise<MailAttachment[]> {
    const source = await this.getMessageSource(messageId);
    const parsed = await simpleParser(source);
    return parsed.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      contentDisposition:
        attachment.contentDisposition === "inline" ? "inline" : "attachment",
      ...(attachment.cid && { cid: attachment.cid }),
    }));
  }

  private async composeMessage(parts: ComposeParts) {
    const from = parts.from || this.config.email;
    const messageId = parts.messageId || generateMessageId(from);
    const threading =
      parts.threading ??
      (parts.inReplyTo?.headers["message-id"]
        ? buildThreadingHeaders({
            headerMessageId: parts.inReplyTo.headers["message-id"],
            references: parts.inReplyTo.headers.references,
          })
        : undefined);
    const options = {
      from,
      to: parts.to,
      cc: parts.cc,
      bcc: parts.bcc,
      replyTo: parts.replyTo,
      subject: parts.subject,
      messageId,
      date: new Date(),
      text: parts.text ?? htmlToText(parts.html),
      html: parts.html,
      attachments: parts.attachments ?? [],
      ...(threading?.inReplyTo && {
        inReplyTo: threading.inReplyTo,
        references: threading.references,
      }),
      headers: { "X-Mailer": "Inbox Zero" },
    };
    return {
      messageId,
      from,
      threadingRoot: threading?.references || messageId,
      mime: await buildMime({ ...options, keepBcc: true }),
      smtpMime: await buildMime(options),
      recipients: collectRecipients(parts.to, parts.cc, parts.bcc),
    };
  }

  private async sendComposed(
    parts: ComposeParts & { threadId?: string },
  ): Promise<{ messageId: string; threadId: string }> {
    const composed = await this.composeMessage(parts);
    await sendRawSmtpMessage(this.config, {
      raw: composed.smtpMime,
      from: extractAddress(composed.from) ?? this.config.email,
      recipients: composed.recipients,
    });

    const sentId = await this.saveSentCopy(
      composed.mime,
      composed.messageId,
    ).catch((error) => {
      // The mail is already out; a missing Sent copy must not look like a failed send.
      this.logger.warn("Failed to save sent copy", { error });
      return null;
    });

    const threadRoot =
      composed.threadingRoot.split(/\s+/).find(Boolean) ?? composed.messageId;
    return {
      messageId: sentId ?? composed.messageId,
      threadId: parts.threadId ?? encodeThreadId(threadRoot),
    };
  }

  /**
   * Gmail and some other servers file SMTP mail into Sent themselves. Check
   * briefly before appending so those accounts don't get two copies.
   */
  private async saveSentCopy(mime: Buffer, rfcMessageId: string) {
    return this.session(async (session, folders) => {
      const sent = folders.byRole.sent;
      if (!sent) return null;
      for (const delay of SENT_COPY_CHECK_DELAYS_MS) {
        await sleep(delay);
        const [existing] = await findByRfcMessageId(
          session,
          [sent],
          rfcMessageId,
        );
        if (existing) return this.idForLocation(session, existing);
      }
      if (session.isGmail) return null;
      const appended = await session.client.append(sent, mime, ["\\Seen"]);
      if (appended !== false && appended.uid && appended.uidValidity) {
        return encodeMessageId({
          mailbox: sent,
          uidValidity: String(appended.uidValidity),
          uid: appended.uid,
          rfcMessageId,
        });
      }
      const [location] = await findByRfcMessageId(
        session,
        [sent],
        rfcMessageId,
      );
      return location ? this.idForLocation(session, location) : null;
    });
  }

  private async appendDraft(mime: Buffer, rfcMessageId: string) {
    return this.session(async (session, folders) => {
      const drafts = folders.byRole.drafts;
      if (!drafts) throw new SafeError("This mailbox has no Drafts folder");
      const appended = await session.client.append(drafts, mime, [
        "\\Draft",
        "\\Seen",
      ]);
      if (appended !== false && appended.uid && appended.uidValidity) {
        return encodeMessageId({
          mailbox: drafts,
          uidValidity: String(appended.uidValidity),
          uid: appended.uid,
          rfcMessageId,
        });
      }
      // Without UIDPLUS the APPEND response carries no UID.
      const [location] = await findByRfcMessageId(
        session,
        [drafts],
        rfcMessageId,
      );
      if (!location) throw new Error("Saved draft could not be found");
      return this.idForLocation(session, location);
    });
  }

  private async idForLocation(session: ImapSession, location: MessageLocation) {
    const uidValidity = await session.withMailbox(
      location.path,
      async (mailbox) => String(mailbox.uidValidity),
      { readOnly: true },
    );
    return encodeMessageId({
      mailbox: location.path,
      uidValidity,
      uid: location.uid,
      rfcMessageId: location.rfcMessageId,
    });
  }

  private async readDraftParts(draftId: string): Promise<DraftParts> {
    const source = await this.getMessageSource(draftId);
    const parsed = await simpleParser(source);
    const address = (value: typeof parsed.to) =>
      value
        ? (Array.isArray(value) ? value : [value])
            .map((item) => item.text)
            .join(", ")
        : undefined;
    return {
      to: address(parsed.to) ?? "",
      from: parsed.from?.text,
      cc: address(parsed.cc),
      bcc: address(parsed.bcc),
      replyTo: parsed.replyTo?.text,
      subject: parsed.subject ?? "",
      html: parsed.html || convertTextToHtmlParagraphs(parsed.text ?? ""),
      text: parsed.text,
      messageId: parsed.messageId,
      threading: parsed.inReplyTo
        ? {
            inReplyTo: parsed.inReplyTo,
            references: Array.isArray(parsed.references)
              ? parsed.references.join(" ")
              : (parsed.references ?? parsed.inReplyTo),
          }
        : undefined,
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        contentDisposition:
          attachment.contentDisposition === "inline" ? "inline" : "attachment",
        ...(attachment.cid && { cid: attachment.cid }),
        headers: attachment.headers.get("x-attachment-id")
          ? {
              "X-Attachment-Id": String(
                attachment.headers.get("x-attachment-id"),
              ),
            }
          : undefined,
      })),
    };
  }

  /** IMAP messages are immutable: a draft edit appends a new version and deletes the old one. */
  private async rewriteDraft(
    draftId: string,
    update: (draft: DraftParts) => DraftParts,
  ): Promise<string> {
    const draft = update(await this.readDraftParts(draftId));
    const composed = await this.composeMessage(draft);
    const newId = await this.appendDraft(composed.mime, composed.messageId);
    await this.session(async (session, folders) => {
      const ref = decodeMessageId(draftId);
      if (!ref) return;
      const oldLocation = await locateMessage(session, folders, draftId).catch(
        () => null,
      );
      const newRef = decodeMessageId(newId);
      if (
        oldLocation &&
        !(
          newRef?.mailbox === oldLocation.path && newRef.uid === oldLocation.uid
        )
      ) {
        await deleteLocations(session, [oldLocation]);
      }
    });
    return newId;
  }
}

type ComposeParts = {
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
  messageId?: string;
  inReplyTo?: ParsedMessage;
  threading?: { inReplyTo: string; references: string };
};

type DraftParts = ComposeParts & { attachments: MailAttachment[] };

function toThread(threadId: string, messages: ParsedMessage[]): EmailThread {
  return {
    id: threadId,
    messages,
    snippet: messages.at(-1)?.snippet ?? "",
  };
}

/** Groups messages (newest first) into threads, newest thread first. */
export function groupIntoThreads(messages: ParsedMessage[]): EmailThread[] {
  const threads = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const list = threads.get(message.threadId) ?? [];
    list.push(message);
    threads.set(message.threadId, list);
  }
  return [...threads.entries()].map(([threadId, list]) =>
    toThread(threadId, sortChronologically(list)),
  );
}

function latestNonDraft(messages: ParsedMessage[]) {
  return getLatestNonDraftMessage({
    messages,
    isDraft: (message) => message.labelIds?.includes("DRAFT") ?? false,
    getTimestamp: getMessageTimestamp,
  });
}

function resolveThreadQueryPaths(folders: FolderMap, query: ThreadsQuery) {
  const labelIds = [
    ...(query.labelIds ?? []),
    ...(query.labelId ? [query.labelId] : []),
    ...(query.folderId ? [query.folderId] : []),
  ];
  for (const labelId of labelIds) {
    const path = resolveLabelToPath(folders, labelId);
    if (path) return [path];
  }
  const roleByType: Partial<Record<string, MailboxRole>> = {
    inbox: "inbox",
    sent: "sent",
    draft: "drafts",
    drafts: "drafts",
    trash: "trash",
    spam: "junk",
    important: "important",
  };
  const type = query.type ?? "inbox";
  if (type === "all" || type === "starred" || type === "unread") {
    return getSearchFolders(folders);
  }
  if (type === "archive") {
    const archive = folders.byRole.archive ?? folders.byRole.all;
    return archive ? [archive] : [];
  }
  const role = roleByType[type];
  if (role) {
    const path = folders.byRole[role];
    return path ? [path] : [];
  }
  const path = resolveLabelToPath(folders, type);
  return path ? [path] : [folders.byRole.inbox ?? "INBOX"];
}

function toLabel(folders: FolderMap, path: string): EmailLabel {
  const role = getRoleForPath(folders, path);
  return {
    id: (role && ROLE_LABEL_IDS[role]) || path,
    name: getFolderDisplayName(path, folders.delimiter),
    type: role || path.toUpperCase() === "INBOX" ? "system" : "user",
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  };
}

function toSystemType(role: MailboxRole | undefined) {
  const map: Partial<Record<MailboxRole, EmailFolderCount["systemType"]>> = {
    inbox: "INBOX",
    drafts: "DRAFT",
    sent: "SENT",
    archive: "ARCHIVE",
    trash: "TRASH",
    junk: "SPAM",
  };
  return role ? map[role] : undefined;
}

function buildFolderTree(folders: FolderMap): OutlookFolder[] {
  const nodes = new Map<string, OutlookFolder>();
  for (const mailbox of folders.all) {
    nodes.set(mailbox.path, {
      id: mailbox.path,
      displayName: mailbox.path.split(folders.delimiter).at(-1) ?? mailbox.path,
      childFolders: [],
      systemType: toSystemType(getRoleForPath(folders, mailbox.path)),
    });
  }
  const roots: OutlookFolder[] = [];
  for (const mailbox of folders.all) {
    const node = nodes.get(mailbox.path);
    if (!node) continue;
    const parentPath = mailbox.path.includes(folders.delimiter)
      ? mailbox.path.slice(0, mailbox.path.lastIndexOf(folders.delimiter))
      : "";
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) parent.childFolders.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) {
    node.childFolderCount = node.childFolders.length;
  }
  // Containers like "[Gmail]" can't hold mail; keep them only for their children.
  return roots.filter(
    (node) =>
      node.childFolders.length ||
      folders.selectable.some((mailbox) => mailbox.path === node.id),
  );
}

function toDraftAttachments(
  draftId: string,
  attachments: MailAttachment[],
): DraftAttachment[] {
  return attachments.map((attachment, index) => {
    const content = attachment.content;
    const size = Buffer.isBuffer(content)
      ? content.length
      : typeof content === "string"
        ? Buffer.byteLength(content)
        : 0;
    return {
      id: attachmentKey(attachment, index),
      filename: attachment.filename || `attachment-${index + 1}`,
      mimeType: attachment.contentType || "application/octet-stream",
      size,
      disposition:
        attachment.contentDisposition === "inline" ? "inline" : "attachment",
      ...(attachment.cid && { contentId: attachment.cid }),
      messageId: draftId,
      providerAttachmentId: String(index),
    };
  });
}

function attachmentKey(attachment: MailAttachment, index: number) {
  const headers = attachment.headers as Record<string, string> | undefined;
  return headers?.["X-Attachment-Id"] ?? `attachment-${index}`;
}

function groupPaths(locations: MessageLocation[]) {
  const groups = new Map<string, number[]>();
  for (const location of locations) {
    groups.set(location.path, [
      ...(groups.get(location.path) ?? []),
      location.uid,
    ]);
  }
  return groups;
}

function dateSearch({ after, before }: { after?: Date; before?: Date }) {
  return {
    ...(after && { since: after }),
    ...(before && { before }),
  } satisfies SearchObject;
}

function htmlToText(html: string) {
  try {
    return convertOutgoingEmailHtmlToText(html);
  } catch {
    return stripHtmlTagsForPlainText(html).trim();
  }
}

function encodePageToken(offset: number) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodePageToken(token?: string) {
  if (!token) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(token, "base64url").toString());
    return Number.isInteger(offset) && offset > 0 ? offset : 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
