import { stripAngles } from "@/utils/imap/ids";

/**
 * The thread root is the oldest Message-ID we can see: the first entry of
 * References (RFC 5322 lists them oldest first), then In-Reply-To, then the
 * message's own Message-ID. Every reply in a conversation carries the same root,
 * so it works as a stable thread key without a server-side thread id.
 */
export function getRootMessageId({
  references,
  inReplyTo,
  messageId,
}: {
  references?: string;
  inReplyTo?: string;
  messageId?: string;
}): string | undefined {
  const fromReferences = references ? parseMessageIdList(references)[0] : "";
  if (fromReferences) return fromReferences;
  const fromInReplyTo = inReplyTo ? parseMessageIdList(inReplyTo)[0] : "";
  if (fromInReplyTo) return fromInReplyTo;
  return messageId ? stripAngles(messageId) || undefined : undefined;
}

/** Parses `<a@x> <b@y>` (or bare ids separated by whitespace or commas). */
export function parseMessageIdList(header: string): string[] {
  const bracketed = [...header.matchAll(/<([^<>]+)>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (bracketed.length) return bracketed;
  return header
    .split(/[\s,]+/)
    .map((id) => stripAngles(id))
    .filter(Boolean);
}
