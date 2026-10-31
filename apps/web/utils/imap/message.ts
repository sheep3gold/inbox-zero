import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Attachment, ParsedMessage } from "@/utils/types";
import {
  encodeMessageId,
  encodeThreadId,
  stripAngles,
  withAngles,
} from "@/utils/imap/ids";
import { getRootMessageId } from "@/utils/imap/thread";
import {
  type FolderMap,
  getFolderLabelId,
  STARRED_LABEL_ID,
  UNREAD_LABEL_ID,
} from "@/utils/imap/folder";

const SNIPPET_LENGTH = 200;

export type RawImapMessage = {
  /** Full RFC 822 source, or only the header block for metadata fetches. */
  source: Buffer;
  uid: number;
  mailbox: string;
  uidValidity: bigint | string;
  flags?: Set<string>;
  /** Gmail X-GM-LABELS, when the server has them. */
  gmailLabels?: Set<string>;
  internalDate?: Date | string;
  size?: number;
};

export async function parseImapMessage(
  raw: RawImapMessage,
  folders: FolderMap,
): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw.source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  return toParsedMessage(raw, parsed, folders);
}

export function toParsedMessage(
  raw: RawImapMessage,
  parsed: ParsedMail,
  folders: FolderMap,
): ParsedMessage {
  const rfcMessageId = parsed.messageId
    ? stripAngles(parsed.messageId)
    : undefined;
  const references = formatReferences(parsed.references);
  const inReplyTo = parsed.inReplyTo ? withAngles(parsed.inReplyTo) : undefined;
  const id = encodeMessageId({
    mailbox: raw.mailbox,
    uidValidity: String(raw.uidValidity),
    uid: raw.uid,
    rfcMessageId,
  });
  const rootMessageId = getRootMessageId({
    references,
    inReplyTo,
    messageId: rfcMessageId,
  });
  // Without any Message-ID the message can only be its own thread.
  const threadId = encodeThreadId(
    rootMessageId ?? `uid:${raw.mailbox}:${raw.uidValidity}:${raw.uid}`,
  );

  const receivedAt = toDate(raw.internalDate) ?? parsed.date ?? new Date(0);
  const sentAt = parsed.date ?? receivedAt;
  const textPlain = parsed.text?.trim() ? parsed.text : undefined;
  const textHtml = parsed.html || undefined;

  const { attachments, inline } = toAttachments(parsed);

  return {
    id,
    threadId,
    historyId: String(raw.uid),
    date: sentAt.toISOString(),
    internalDate: String(receivedAt.getTime()),
    subject: parsed.subject ?? "",
    snippet: buildSnippet(textPlain, textHtml),
    textPlain,
    textHtml,
    headers: {
      from: formatAddresses(parsed.from),
      to: formatAddresses(parsed.to),
      ...optional("cc", formatAddresses(parsed.cc)),
      ...optional("bcc", formatAddresses(parsed.bcc)),
      ...optional("reply-to", formatAddresses(parsed.replyTo)),
      subject: parsed.subject ?? "",
      date: sentAt.toUTCString(),
      ...optional("message-id", rfcMessageId && withAngles(rfcMessageId)),
      ...optional("in-reply-to", inReplyTo),
      ...optional("references", references),
      ...optional("list-unsubscribe", getRawHeader(parsed, "list-unsubscribe")),
      ...optional(
        "list-unsubscribe-post",
        getRawHeader(parsed, "list-unsubscribe-post"),
      ),
    },
    labelIds: buildLabelIds(raw, folders),
    attachments,
    inline,
    hasAttachment: attachments.length > 0,
    parentFolderId: raw.mailbox,
  };
}

export function buildLabelIds(
  raw: Pick<RawImapMessage, "mailbox" | "flags" | "gmailLabels">,
  folders: FolderMap,
  extraFolders: string[] = [],
): string[] {
  const labelIds = new Set<string>();

  for (const path of [raw.mailbox, ...extraFolders]) {
    const labelId = getFolderLabelId(folders, path);
    if (labelId) labelIds.add(labelId);
  }

  for (const label of raw.gmailLabels ?? []) {
    const labelId = gmailLabelToLabelId(label, folders);
    if (labelId) labelIds.add(labelId);
  }

  if (raw.flags && !raw.flags.has("\\Seen")) labelIds.add(UNREAD_LABEL_ID);
  if (raw.flags?.has("\\Flagged")) labelIds.add(STARRED_LABEL_ID);
  if (raw.flags?.has("\\Draft")) labelIds.add("DRAFT");

  return [...labelIds];
}

/** Gmail reports system labels as \Inbox, \Sent, ... and user labels by name. */
function gmailLabelToLabelId(label: string, folders: FolderMap) {
  const systemLabels: Record<string, string> = {
    "\\Inbox": "INBOX",
    "\\Sent": "SENT",
    "\\Draft": "DRAFT",
    "\\Drafts": "DRAFT",
    "\\Trash": "TRASH",
    "\\Spam": "SPAM",
    "\\Junk": "SPAM",
    "\\Important": "IMPORTANT",
    "\\Starred": STARRED_LABEL_ID,
  };
  if (label.startsWith("\\")) return systemLabels[label];
  return getFolderLabelId(folders, label);
}

export function formatAddresses(
  value: AddressObject | AddressObject[] | undefined,
): string {
  if (!value) return "";
  const objects = Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) => object.value)
    .map((address) => {
      if (!address.address) return address.name ?? "";
      if (!address.name) return address.address;
      return `${quoteDisplayName(address.name)} <${address.address}>`;
    })
    .filter(Boolean)
    .join(", ");
}

function quoteDisplayName(name: string) {
  return /[",<>@;:]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
}

function formatReferences(references: ParsedMail["references"]) {
  if (!references) return;
  const list = Array.isArray(references) ? references : references.split(/\s+/);
  const formatted = list
    .map((reference) => reference.trim())
    .filter(Boolean)
    .map(withAngles);
  return formatted.length ? formatted.join(" ") : undefined;
}

function getRawHeader(parsed: ParsedMail, key: string) {
  const line = parsed.headerLines.find((header) => header.key === key)?.line;
  if (!line) return;
  return line
    .slice(line.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

function toAttachments(parsed: ParsedMail) {
  const attachments: Attachment[] = [];
  const inline: Attachment[] = [];

  parsed.attachments.forEach((attachment, index) => {
    const isInline =
      attachment.contentDisposition === "inline" && !!attachment.cid;
    const item: Attachment = {
      attachmentId: String(index),
      filename: attachment.filename ?? `attachment-${index + 1}`,
      mimeType: attachment.contentType,
      size: attachment.size,
      headers: {
        "content-description": "",
        "content-disposition": attachment.contentDisposition,
        "content-id": attachment.contentId ?? "",
        "content-transfer-encoding": "",
        "content-type": attachment.contentType,
      },
    };
    (isInline ? inline : attachments).push(item);
  });

  return { attachments, inline };
}

function buildSnippet(textPlain?: string, textHtml?: string) {
  const text =
    textPlain ??
    (textHtml
      ? textHtml
          .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " ")
      : "");
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
}

function toDate(value: Date | string | undefined) {
  if (!value) return;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function optional<K extends string>(key: K, value: string | undefined) {
  return (value ? { [key]: value } : {}) as Partial<Record<K, string>>;
}
