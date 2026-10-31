import type { FetchQueryObject, SearchObject } from "imapflow";
import type { ParsedMessage } from "@/utils/types";
import type { ImapSession } from "@/utils/imap/client";
import {
  buildFolderMap,
  type FolderMap,
  isUserFolder,
} from "@/utils/imap/folder";
import {
  decodeMessageId,
  decodeThreadId,
  encodeThreadId,
  stripAngles,
} from "@/utils/imap/ids";
import { parseImapMessage, type RawImapMessage } from "@/utils/imap/message";
import { getRootMessageId, parseMessageIdList } from "@/utils/imap/thread";
import { ImapMessageNotFoundError } from "@/utils/imap/types";

export type MessageFormat = "full" | "metadata";

export type MessageLocation = {
  path: string;
  uid: number;
  rfcMessageId?: string;
};

// Folders without HEADER search support are scanned instead, newest first.
const HEADER_SCAN_LIMIT = 500;
const MAX_SEARCH_FOLDERS = 40;

export async function getFolders(session: ImapSession): Promise<FolderMap> {
  return buildFolderMap(await session.listMailboxes());
}

/**
 * Folders that can hold a conversation. Gmail's All Mail already contains every
 * label, so searching it alone avoids duplicates and extra round trips.
 */
export function getSearchFolders(
  folders: FolderMap,
  {
    includeDrafts = false,
    includeSpamTrash = false,
    includeSent = true,
  }: {
    includeDrafts?: boolean;
    includeSpamTrash?: boolean;
    includeSent?: boolean;
  } = {},
): string[] {
  const { byRole } = folders;
  const paths: string[] = [];
  const add = (path?: string) => {
    if (path && !paths.includes(path)) paths.push(path);
  };

  if (byRole.all) {
    add(byRole.all);
  } else {
    add(byRole.inbox);
    if (includeSent) add(byRole.sent);
    add(byRole.archive);
    for (const mailbox of folders.selectable) {
      if (isUserFolder(folders, mailbox)) add(mailbox.path);
    }
  }
  if (includeDrafts) add(byRole.drafts);
  if (includeSpamTrash) {
    add(byRole.junk);
    add(byRole.trash);
  }
  return paths.slice(0, MAX_SEARCH_FOLDERS);
}

export async function searchUids(
  session: ImapSession,
  path: string,
  query: SearchObject,
): Promise<number[]> {
  return session.withMailbox(
    path,
    async () => {
      const result = await session.client.search(query, { uid: true });
      return (result || []).sort((a, b) => b - a);
    },
    { readOnly: true },
  );
}

export async function fetchMessages(
  session: ImapSession,
  folders: FolderMap,
  path: string,
  uids: number[],
  format: MessageFormat = "full",
): Promise<ParsedMessage[]> {
  if (!uids.length) return [];
  const raws = await fetchRaw(session, path, uids, format);
  const order = new Map(uids.map((uid, index) => [uid, index]));
  const parsed = await Promise.all(
    raws.map((raw) => parseImapMessage(raw, folders)),
  );
  return parsed.sort(
    (a, b) =>
      (order.get(Number(a.historyId)) ?? 0) -
      (order.get(Number(b.historyId)) ?? 0),
  );
}

export async function fetchRaw(
  session: ImapSession,
  path: string,
  uids: number[],
  format: MessageFormat,
): Promise<RawImapMessage[]> {
  const query: FetchQueryObject = {
    uid: true,
    flags: true,
    internalDate: true,
    size: true,
    ...(format === "full" ? { source: true } : { headers: true }),
    ...(session.isGmail && { labels: true }),
  };

  return session.withMailbox(
    path,
    async (mailbox) => {
      const raws: RawImapMessage[] = [];
      // Nothing else may run on the connection while a FETCH streams, so collect first.
      for await (const message of session.client.fetch(uids.join(","), query, {
        uid: true,
      })) {
        const source = format === "full" ? message.source : message.headers;
        if (!source) continue;
        raws.push({
          source,
          uid: message.uid,
          mailbox: mailbox.path,
          uidValidity: mailbox.uidValidity,
          flags: message.flags,
          gmailLabels: message.labels,
          internalDate: message.internalDate,
          size: message.size,
        });
      }
      return raws;
    },
    { readOnly: true },
  );
}

/** Finds a message by our id; falls back to its Message-ID when it moved. */
export async function locateMessage(
  session: ImapSession,
  folders: FolderMap,
  messageId: string,
): Promise<MessageLocation> {
  const ref = decodeMessageId(messageId);
  if (!ref) throw new ImapMessageNotFoundError(messageId);

  const folderExists = folders.selectable.some(
    (mailbox) => mailbox.path === ref.mailbox,
  );
  if (folderExists) {
    const found = await session.withMailbox(
      ref.mailbox,
      async (mailbox) => {
        if (String(mailbox.uidValidity) !== ref.uidValidity) return false;
        const result = await session.client.search(
          { uid: String(ref.uid) },
          { uid: true },
        );
        return !!result && result.includes(ref.uid);
      },
      { readOnly: true },
    );
    if (found) {
      return {
        path: ref.mailbox,
        uid: ref.uid,
        rfcMessageId: ref.rfcMessageId,
      };
    }
  }

  if (ref.rfcMessageId) {
    const paths = [
      ...new Set([
        ...(folderExists ? [ref.mailbox] : []),
        ...getSearchFolders(folders, {
          includeDrafts: true,
          includeSpamTrash: true,
        }),
      ]),
    ];
    const [location] = await findByRfcMessageId(
      session,
      paths,
      ref.rfcMessageId,
    );
    if (location) return location;
  }

  throw new ImapMessageNotFoundError(messageId);
}

export async function findByRfcMessageId(
  session: ImapSession,
  paths: string[],
  rfcMessageId: string,
  { firstOnly = true }: { firstOnly?: boolean } = {},
): Promise<MessageLocation[]> {
  const wanted = stripAngles(rfcMessageId);
  const locations: MessageLocation[] = [];
  for (const path of paths) {
    const uids = await searchHeaderWithFallback(session, path, (headers) =>
      headers.messageIds.includes(wanted),
    )({ header: { "message-id": wanted } });
    for (const uid of uids) {
      locations.push({ path, uid, rfcMessageId: wanted });
    }
    if (firstOnly && locations.length) break;
  }
  return locations;
}

/** Every copy of the thread's messages in the given folders. */
export async function findThreadLocations(
  session: ImapSession,
  paths: string[],
  threadId: string,
): Promise<MessageLocation[]> {
  const root = decodeThreadId(threadId);
  if (!root) return [];
  const uidRoot = parseUidRoot(root);
  if (uidRoot) {
    return paths.includes(uidRoot.path) ? [uidRoot] : [];
  }

  const locations: MessageLocation[] = [];
  for (const path of paths) {
    const uids = await searchHeaderWithFallback(
      session,
      path,
      (headers) => headers.threadId === threadId,
    )({
      or: [
        { header: { "message-id": root } },
        { header: { references: root } },
        { header: { "in-reply-to": root } },
      ],
    });
    for (const uid of uids) locations.push({ path, uid });
  }
  return locations;
}

export function groupByPath(locations: MessageLocation[]) {
  const groups = new Map<string, number[]>();
  for (const location of locations) {
    const uids = groups.get(location.path) ?? [];
    if (!uids.includes(location.uid)) uids.push(location.uid);
    groups.set(location.path, uids);
  }
  return groups;
}

export async function moveLocations(
  session: ImapSession,
  locations: MessageLocation[],
  destination: string,
) {
  for (const [path, uids] of groupByPath(locations)) {
    if (path === destination) continue;
    await session.withMailbox(path, () =>
      session.client.messageMove(uids.join(","), destination, { uid: true }),
    );
  }
}

export async function copyLocations(
  session: ImapSession,
  locations: MessageLocation[],
  destination: string,
) {
  for (const [path, uids] of groupByPath(locations)) {
    if (path === destination) continue;
    await session.withMailbox(path, () =>
      session.client.messageCopy(uids.join(","), destination, { uid: true }),
    );
  }
}

export async function deleteLocations(
  session: ImapSession,
  locations: MessageLocation[],
) {
  for (const [path, uids] of groupByPath(locations)) {
    await session.withMailbox(path, () =>
      session.client.messageDelete(uids.join(","), { uid: true }),
    );
  }
}

export async function setFlag(
  session: ImapSession,
  locations: MessageLocation[],
  flag: string,
  enabled: boolean,
) {
  for (const [path, uids] of groupByPath(locations)) {
    await session.withMailbox(path, () =>
      enabled
        ? session.client.messageFlagsAdd(uids.join(","), [flag], { uid: true })
        : session.client.messageFlagsRemove(uids.join(","), [flag], {
            uid: true,
          }),
    );
  }
}

/** Fetches the messages at these locations and merges copies of one message. */
export async function fetchLocations(
  session: ImapSession,
  folders: FolderMap,
  locations: MessageLocation[],
  format: MessageFormat = "full",
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];
  for (const [path, uids] of groupByPath(locations)) {
    messages.push(
      ...(await fetchMessages(session, folders, path, uids, format)),
    );
  }
  return dedupeCopies(messages, folders);
}

/**
 * A message filed into folders is stored once per folder. Present it once,
 * with the labels of every copy, and prefer the inbox copy's id.
 */
export function dedupeCopies(
  messages: ParsedMessage[],
  folders: FolderMap,
): ParsedMessage[] {
  const byKey = new Map<string, ParsedMessage>();
  for (const message of messages) {
    const key = message.headers["message-id"] || message.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, message);
      continue;
    }
    const labelIds = [
      ...new Set([...(existing.labelIds ?? []), ...(message.labelIds ?? [])]),
    ];
    const preferNew =
      message.parentFolderId === folders.byRole.inbox &&
      existing.parentFolderId !== folders.byRole.inbox;
    byKey.set(key, { ...(preferNew ? message : existing), labelIds });
  }
  return [...byKey.values()];
}

export function sortChronologically(messages: ParsedMessage[]) {
  return [...messages].sort(
    (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
  );
}

type ScannedHeaders = { messageIds: string[]; threadId: string };

/**
 * Runs a HEADER search, and if the server rejects it (some servers only
 * search a few headers), scans the newest messages' headers instead.
 */
function searchHeaderWithFallback(
  session: ImapSession,
  path: string,
  matches: (headers: ScannedHeaders) => boolean,
) {
  return async (query: SearchObject): Promise<number[]> => {
    try {
      return await searchUids(session, path, query);
    } catch {
      return scanHeaders(session, path, matches);
    }
  };
}

async function scanHeaders(
  session: ImapSession,
  path: string,
  matches: (headers: ScannedHeaders) => boolean,
): Promise<number[]> {
  return session.withMailbox(
    path,
    async (mailbox) => {
      if (!mailbox.exists) return [];
      const start = Math.max(1, mailbox.exists - HEADER_SCAN_LIMIT + 1);
      const uids: number[] = [];
      for await (const message of session.client.fetch(`${start}:*`, {
        uid: true,
        headers: ["message-id", "references", "in-reply-to"],
      })) {
        const headers = parseThreadHeaders(message.headers);
        if (matches(headers)) uids.push(message.uid);
      }
      return uids;
    },
    { readOnly: true },
  );
}

export function parseThreadHeaders(raw?: Buffer): ScannedHeaders {
  const text = (raw?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ");
  const get = (name: string) =>
    text
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim();
  const messageId = get("message-id");
  const references = get("references");
  const inReplyTo = get("in-reply-to");
  const root = getRootMessageId({ references, inReplyTo, messageId });
  return {
    messageIds: messageId ? parseMessageIdList(messageId) : [],
    threadId: root ? encodeThreadId(root) : "",
  };
}

function parseUidRoot(root: string): MessageLocation | null {
  const match = /^uid:(.*):(\d+):(\d+)$/.exec(root);
  if (!match) return null;
  return { path: match[1], uid: Number(match[3]) };
}
