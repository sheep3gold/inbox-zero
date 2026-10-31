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
  stripAngles,
  withAngles,
} from "@/utils/imap/ids";
import { parseImapMessage, type RawImapMessage } from "@/utils/imap/message";
import {
  CLIENT_FILTER_FETCH_HEADERS,
  type ClientFilterMessage,
  FULL_SEARCH_SUPPORT,
  matchesSearch,
  needsClientFilter,
  probeSearchSupport,
  type SearchSupport,
  serverPrefilter,
  withoutServerKeys,
} from "@/utils/imap/search-fallback";
import { ImapMessageNotFoundError } from "@/utils/imap/types";

export type MessageFormat = "full" | "metadata";

export type MessageLocation = {
  path: string;
  uid: number;
  rfcMessageId?: string;
};

// Newest messages matched locally when the server can't run a search itself.
// QQ Mail fetches roughly 40 envelopes a second, so keep these small.
const CLIENT_FILTER_SCAN_LIMIT = 500;
const THREAD_SCAN_LIMIT = 300;
const SCAN_CACHE_PER_FOLDER = 3000;
const SCAN_CACHE_FOLDERS = 200;

// Envelopes and headers never change for a UID, so scans are cached per
// folder and UIDVALIDITY for the life of the process.
const scanCaches = new Map<string, Map<number, ClientFilterMessage>>();

function getScanCache(key: string) {
  let cache = scanCaches.get(key);
  if (!cache) {
    cache = new Map();
    scanCaches.set(key, cache);
    if (scanCaches.size > SCAN_CACHE_FOLDERS) {
      const oldest = scanCaches.keys().next().value;
      if (oldest !== undefined) scanCaches.delete(oldest);
    }
  }
  return cache;
}

function trimScanCache(cache: Map<number, ClientFilterMessage>) {
  if (cache.size <= SCAN_CACHE_PER_FOLDER) return;
  const uids = [...cache.keys()].sort((a, b) => a - b);
  for (const uid of uids.slice(0, cache.size - SCAN_CACHE_PER_FOLDER)) {
    cache.delete(uid);
  }
}
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

/**
 * UID SEARCH, newest first. Where the server's SEARCH is unreliable for a
 * key (see probeSearchSupport), the server narrows by the keys it does
 * handle and the rest is matched locally on the newest messages.
 */
export async function searchUids(
  session: ImapSession,
  path: string,
  query: SearchObject,
  { scanLimit }: { scanLimit?: number } = {},
): Promise<number[]> {
  const support = session.isGmail
    ? FULL_SEARCH_SUPPORT
    : await getSearchSupport(session);
  const clientSide = needsClientFilter(query, support);
  return session.withMailbox(
    path,
    async () => {
      if (!clientSide) {
        try {
          return await serverSearch(session, query);
        } catch (error) {
          if (!hasClientFilterableKeys(query)) throw error;
        }
      }
      return clientFilterSearch(session, query, scanLimit);
    },
    { readOnly: true },
  );
}

async function serverSearch(session: ImapSession, query: SearchObject) {
  const result = await session.client.search(query, { uid: true });
  return (result || []).sort((a, b) => b - a);
}

async function clientFilterSearch(
  session: ImapSession,
  query: SearchObject,
  limit = CLIENT_FILTER_SCAN_LIMIT,
) {
  const candidates = (
    await serverSearch(session, serverPrefilter(query))
  ).slice(0, limit);
  if (!candidates.length) return [];
  const mailbox = session.client.mailbox;
  if (!mailbox) return [];
  const cache = getScanCache(
    `${session.cacheKey}\u0000${mailbox.path}\u0000${mailbox.uidValidity}`,
  );
  const missing = candidates.filter((uid) => !cache.has(uid));
  if (missing.length) {
    for await (const message of session.client.fetch(
      missing.join(","),
      {
        uid: true,
        envelope: true,
        internalDate: true,
        headers: CLIENT_FILTER_FETCH_HEADERS,
      },
      { uid: true },
    )) {
      cache.set(message.uid, message);
    }
    trimScanCache(cache);
  }
  // Flags and dates were already applied by the server prefilter, and cached
  // flags may be stale, so only the remaining keys are matched here.
  const localQuery = withoutServerKeys(query);
  return candidates
    .filter((uid) => {
      const message = cache.get(uid);
      return message ? matchesSearch(localQuery, message) : false;
    })
    .sort((a, b) => b - a);
}

function hasClientFilterableKeys(query: SearchObject) {
  return needsClientFilter(query, {
    header: false,
    address: false,
    partialAddress: false,
    subject: false,
    text: false,
  });
}

/** Measured once per connection against the newest INBOX message. */
function getSearchSupport(session: ImapSession): Promise<SearchSupport> {
  session.searchSupport ??= session
    .withMailbox(
      "INBOX",
      async (mailbox) => {
        if (!mailbox.exists) return FULL_SEARCH_SUPPORT;
        const latest = await session.client.fetchOne(
          "*",
          { uid: true, envelope: true },
          { uid: false },
        );
        if (!latest) return FULL_SEARCH_SUPPORT;
        return probeSearchSupport(
          {
            uid: latest.uid,
            messageId: latest.envelope?.messageId,
            fromAddress: latest.envelope?.from?.[0]?.address,
            subject: latest.envelope?.subject,
          },
          (probe) => serverSearch(session, probe),
        );
      },
      { readOnly: true },
    )
    .catch(() => FULL_SEARCH_SUPPORT);
  return session.searchSupport;
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
    // NetEase only matches the id with its angle brackets.
    const uids = await searchUids(session, path, {
      header: { "message-id": withAngles(wanted) },
    });
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
    const uids = session.isGmail
      ? await findGmailThreadUids(session, path, root)
      : undefined;
    for (const uid of uids ??
      (await searchUids(
        session,
        path,
        {
          or: [
            { header: { "message-id": withAngles(root) } },
            { header: { references: withAngles(root) } },
            { header: { "in-reply-to": withAngles(root) } },
          ],
        },
        { scanLimit: THREAD_SCAN_LIMIT },
      ))) {
      locations.push({ path, uid });
    }
  }
  return locations;
}

/**
 * HEADER searches over a large Gmail All Mail take 15s or more. Find the root
 * by Message-ID (indexed) and take its Gmail thread instead. Returns
 * undefined when the root isn't in the folder, so the caller falls back.
 */
async function findGmailThreadUids(
  session: ImapSession,
  path: string,
  root: string,
): Promise<number[] | undefined> {
  return session.withMailbox(
    path,
    async () => {
      const [rootUid] = await serverSearch(session, {
        gmraw: `rfc822msgid:${root}`,
      });
      if (!rootUid) return;
      const message = await session.client.fetchOne(
        String(rootUid),
        { uid: true, threadId: true },
        { uid: true },
      );
      if (message === false || !message.threadId) return;
      return serverSearch(session, { threadId: message.threadId });
    },
    { readOnly: true },
  );
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

function parseUidRoot(root: string): MessageLocation | null {
  const match = /^uid:(.*):(\d+):(\d+)$/.exec(root);
  if (!match) return null;
  return { path: match[1], uid: Number(match[3]) };
}
