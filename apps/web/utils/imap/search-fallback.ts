import { randomBytes } from "node:crypto";
import type {
  FetchMessageObject,
  MessageAddressObject,
  SearchObject,
} from "imapflow";
import { stripAngles } from "@/utils/imap/ids";

/**
 * Which SEARCH keys a server actually honors. Measured, not advertised:
 * NetEase (qiye.163.com) accepts FROM/SUBJECT/TEXT but always returns
 * nothing, and only matches HEADER Message-ID with angle brackets. QQ Mail
 * ignores HEADER, matches FROM only on full addresses and returns every
 * message for any TEXT.
 */
export type SearchSupport = {
  header: boolean;
  /** FROM/TO/... with a full address. */
  address: boolean;
  /** FROM/TO/... with part of an address, such as a domain. */
  partialAddress: boolean;
  subject: boolean;
  text: boolean;
};

export const FULL_SEARCH_SUPPORT: SearchSupport = {
  header: true,
  address: true,
  partialAddress: true,
  subject: true,
  text: true,
};

/** Keys every server we've seen handles correctly. */
const SERVER_SAFE_KEYS = new Set([
  "all",
  "uid",
  "seq",
  "seen",
  "flagged",
  "answered",
  "deleted",
  "draft",
  "since",
  "before",
  "on",
  "sentSince",
  "sentBefore",
]);

const ADDRESS_KEYS = new Set(["from", "to", "cc", "bcc"]);
const TEXT_KEYS = new Set(["text", "body"]);

export type ProbeTarget = {
  uid: number;
  messageId?: string;
  fromAddress?: string;
  subject?: string;
};

/**
 * Checks the server's SEARCH against one message we know is there. `search`
 * runs a UID SEARCH in the folder that holds `target`.
 */
export async function probeSearchSupport(
  target: ProbeTarget | null,
  search: (query: SearchObject) => Promise<number[]>,
): Promise<SearchSupport> {
  if (!target) return FULL_SEARCH_SUPPORT;

  const finds = async (query: SearchObject) => {
    try {
      return (await search(query)).includes(target.uid);
    } catch {
      return false;
    }
  };
  // A key the server ignores can also match everything.
  const nonsense = `zq${randomBytes(6).toString("hex")}`;
  const rejectsNonsense = async (query: SearchObject) => {
    try {
      return (await search(query)).length === 0;
    } catch {
      return false;
    }
  };

  const header = target.messageId
    ? await finds({
        header: { "message-id": `<${stripAngles(target.messageId)}>` },
      })
    : true;

  const domain = target.fromAddress?.split("@")[1];
  const address = target.fromAddress
    ? (await finds({ from: target.fromAddress })) &&
      (await rejectsNonsense({ from: `${nonsense}@example.com` }))
    : true;
  const partialAddress =
    address && domain ? await finds({ from: domain }) : address;

  const subjectWord = target.subject
    ?.split(/\s+/)
    .find((word) => /^[\p{L}\p{N}]{3,}$/u.test(word));
  const subject = subjectWord
    ? (await finds({ subject: subjectWord })) &&
      (await rejectsNonsense({ subject: nonsense }))
    : address;

  const text = subject && (await rejectsNonsense({ text: nonsense }));

  return { header, address, partialAddress, subject, text };
}

/** True when part of the query must be evaluated locally on this server. */
export function needsClientFilter(
  query: SearchObject,
  support: SearchSupport,
): boolean {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || SERVER_SAFE_KEYS.has(key)) continue;
    if (key === "header") {
      if (!support.header) return true;
      continue;
    }
    if (ADDRESS_KEYS.has(key)) {
      const full = String(value).includes("@");
      if (!(full ? support.address : support.partialAddress)) return true;
      continue;
    }
    if (key === "subject") {
      if (!support.subject) return true;
      continue;
    }
    if (TEXT_KEYS.has(key)) {
      if (!support.text) return true;
      continue;
    }
    if (key === "not") {
      if (needsClientFilter(value as SearchObject, support)) return true;
      continue;
    }
    if (key === "or") {
      if (
        (value as SearchObject[]).some((item) =>
          needsClientFilter(item, support),
        )
      )
        return true;
    }
    // Unknown or server-specific keys (gmraw, threadId, ...) stay on the server.
  }
  return false;
}

/** The top-level keys the server can filter on, to narrow a local scan. */
export function serverPrefilter(query: SearchObject): SearchObject {
  const prefilter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (SERVER_SAFE_KEYS.has(key) && value !== undefined)
      prefilter[key] = value;
  }
  return Object.keys(prefilter).length
    ? (prefilter as SearchObject)
    : { all: true };
}

/** The query minus the keys the server prefilter already applied. */
export function withoutServerKeys(query: SearchObject): SearchObject {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!SERVER_SAFE_KEYS.has(key)) rest[key] = value;
  }
  return rest as SearchObject;
}

export const CLIENT_FILTER_FETCH_HEADERS = [
  "message-id",
  "references",
  "in-reply-to",
  "content-type",
];

export type ClientFilterMessage = Pick<
  FetchMessageObject,
  "uid" | "flags" | "envelope" | "internalDate" | "headers"
>;

/**
 * Evaluates an IMAP search locally. TEXT/BODY can only see the envelope
 * (subject and addresses) because bodies aren't fetched for the scan.
 */
export function matchesSearch(
  query: SearchObject,
  message: ClientFilterMessage,
  headers = parseHeaderBlock(message.headers),
): boolean {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (!matchesKey(key, value, message, headers)) return false;
  }
  return true;
}

function matchesKey(
  key: string,
  value: unknown,
  message: ClientFilterMessage,
  headers: Record<string, string>,
): boolean {
  const flags = message.flags ?? new Set<string>();
  const envelope = message.envelope;
  const date = message.internalDate
    ? new Date(message.internalDate)
    : undefined;
  switch (key) {
    case "all":
      return true;
    case "uid":
      return true; // Already applied by the server prefilter.
    case "seen":
      return flags.has("\\Seen") === value;
    case "flagged":
      return flags.has("\\Flagged") === value;
    case "answered":
      return flags.has("\\Answered") === value;
    case "deleted":
      return flags.has("\\Deleted") === value;
    case "draft":
      return flags.has("\\Draft") === value;
    case "since":
    case "sentSince":
      return !!date && date >= startOfDay(value as Date | string);
    case "before":
    case "sentBefore":
      return !!date && date < startOfDay(value as Date | string);
    case "from":
    case "to":
    case "cc":
    case "bcc":
      return contains(formatAddresses(envelope?.[key]), String(value));
    case "subject":
      return contains(envelope?.subject ?? "", String(value));
    case "text":
    case "body":
      return contains(
        [
          envelope?.subject,
          formatAddresses(envelope?.from),
          formatAddresses(envelope?.to),
          formatAddresses(envelope?.cc),
        ].join(" "),
        String(value),
      );
    case "header":
      return Object.entries(value as Record<string, string | boolean>).every(
        ([name, wanted]) => {
          const actual = headers[name.toLowerCase()];
          if (wanted === true) return actual !== undefined;
          if (actual === undefined) return false;
          return contains(actual, stripAngles(String(wanted)));
        },
      );
    case "not":
      return !matchesSearch(value as SearchObject, message, headers);
    case "or":
      return (value as SearchObject[]).some((item) =>
        matchesSearch(item, message, headers),
      );
    default:
      return true;
  }
}

export function parseHeaderBlock(raw?: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  const text = (raw?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  return headers;
}

function formatAddresses(addresses?: MessageAddressObject[]) {
  return (addresses ?? [])
    .map((address) => `${address.name ?? ""} <${address.address ?? ""}>`)
    .join(", ");
}

function contains(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function startOfDay(value: Date | string) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
