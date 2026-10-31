import type { SearchObject } from "imapflow";

/**
 * Translates the Gmail-style query strings the app builds (`from:x`,
 * `subject:"y"`, `is:unread`, `after:2024/01/31`, free text) into an IMAP
 * SEARCH. Gmail servers get the query verbatim through X-GM-RAW instead.
 * Unknown operators fall back to a full-text search for the whole token.
 */
export function buildImapSearch(
  query: string | undefined,
  { gmail = false }: { gmail?: boolean } = {},
): SearchObject {
  const trimmed = query?.trim();
  if (!trimmed) return { all: true };
  if (gmail) return { gmraw: trimmed };

  const conditions: SearchObject[] = [];
  const words: string[] = [];
  for (const token of tokenize(trimmed)) {
    // Free words become one TEXT phrase: nested search groups are valid
    // IMAP, but some servers (GreenMail, older Exchange) mishandle them.
    if (!token.key && !token.negated) {
      words.push(token.value);
      continue;
    }
    const condition = tokenToCondition(token);
    if (condition) conditions.push(condition);
  }
  if (words.length) conditions.unshift({ text: words.join(" ") });
  return mergeConditions(conditions);
}

export function mergeConditions(conditions: SearchObject[]): SearchObject {
  const merged: SearchObject = {};
  const extra: SearchObject[] = [];
  for (const condition of conditions) {
    for (const [key, value] of Object.entries(condition) as Array<
      [keyof SearchObject, unknown]
    >) {
      if (key in merged) {
        extra.push({ [key]: value } as SearchObject);
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  if (!Object.keys(merged).length) return { all: true };
  if (!extra.length) return merged;
  // imapflow ANDs the keys of one object, so a repeated key needs a nested
  // group. A one-element `or` compiles to a parenthesized AND group.
  return extra.reduce<SearchObject>(
    (accumulator, condition) => ({ ...condition, or: [accumulator] }),
    merged,
  );
}

type Token = { negated: boolean; key?: string; value: string };

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(-)?(?:(\w+):)?("([^"]*)"|\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const [, minus, key, rawValue, quotedValue] = match;
    const value = quotedValue ?? rawValue;
    if (!value || value === "OR" || value === "AND") continue;
    tokens.push({
      negated: !!minus,
      key: key?.toLowerCase(),
      value: value.replace(/^\(|\)$/g, ""),
    });
  }
  return tokens;
}

function tokenToCondition(token: Token): SearchObject | null {
  const condition = keyToCondition(token);
  if (!condition) return null;
  return token.negated ? { not: condition } : condition;
}

function keyToCondition({ key, value }: Token): SearchObject | null {
  switch (key) {
    case "from":
      return { from: value };
    case "to":
      return { to: value };
    case "cc":
      return { cc: value };
    case "bcc":
      return { bcc: value };
    case "subject":
      return { subject: value };
    case "after":
    case "since":
    case "newer": {
      const date = parseQueryDate(value);
      return date ? { since: date } : null;
    }
    case "before":
    case "older": {
      const date = parseQueryDate(value);
      return date ? { before: date } : null;
    }
    case "is":
      return isCondition(value);
    case "has":
      return value === "attachment"
        ? { header: { "content-type": "multipart/mixed" } }
        : null;
    case "in":
    case "label":
    case "category":
    case "newer_than":
    case "older_than":
      // Folder scoping is handled by the caller; Gmail categories don't exist here.
      return null;
    case undefined:
      return { text: value };
    default:
      return { text: `${key}:${value}` };
  }
}

function isCondition(value: string): SearchObject | null {
  switch (value) {
    case "unread":
      return { seen: false };
    case "read":
      return { seen: true };
    case "starred":
    case "flagged":
      return { flagged: true };
    case "unstarred":
      return { flagged: false };
    default:
      return null;
  }
}

function parseQueryDate(value: string): Date | null {
  if (/^\d{9,}$/.test(value)) {
    // Gmail accepts epoch seconds.
    return new Date(Number(value) * 1000);
  }
  const normalized = value.replace(/\//g, "-");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
