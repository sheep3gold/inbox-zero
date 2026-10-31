/**
 * IMAP UIDs are only unique within one folder and one UIDVALIDITY, and change
 * whenever a message moves. Our message id therefore carries the folder, the
 * UIDVALIDITY, the UID and the RFC 822 Message-ID: the first three locate the
 * message fast, and the Message-ID finds it again after it moved.
 */
export type ImapMessageRef = {
  mailbox: string;
  uidValidity: string;
  uid: number;
  rfcMessageId?: string;
};

const MESSAGE_ID_PREFIX = "imap1_";
const THREAD_ID_PREFIX = "imapt1_";

export function encodeMessageId(ref: ImapMessageRef): string {
  const rfcMessageId = ref.rfcMessageId ? stripAngles(ref.rfcMessageId) : "";
  return [
    `${MESSAGE_ID_PREFIX}${ref.uid}`,
    ref.uidValidity,
    toBase64Url(ref.mailbox),
    toBase64Url(rfcMessageId),
  ].join(".");
}

export function decodeMessageId(id: string): ImapMessageRef | null {
  if (!id.startsWith(MESSAGE_ID_PREFIX)) return null;
  const parts = id.slice(MESSAGE_ID_PREFIX.length).split(".");
  if (parts.length !== 4) return null;
  const [uid, uidValidity, mailbox, rfcMessageId] = parts;
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(uidValidity) || !mailbox) {
    return null;
  }
  try {
    const decodedRfcId = fromBase64Url(rfcMessageId);
    return {
      mailbox: fromBase64Url(mailbox),
      uidValidity,
      uid: Number(uid),
      ...(decodedRfcId && { rfcMessageId: decodedRfcId }),
    };
  } catch {
    return null;
  }
}

export function isImapMessageId(id: string) {
  return id.startsWith(MESSAGE_ID_PREFIX);
}

/** The thread id carries the root Message-ID so the thread can be searched for. */
export function encodeThreadId(rootMessageId: string): string {
  return `${THREAD_ID_PREFIX}${toBase64Url(stripAngles(rootMessageId))}`;
}

export function decodeThreadId(threadId: string): string | null {
  if (!threadId.startsWith(THREAD_ID_PREFIX)) return null;
  try {
    const root = fromBase64Url(threadId.slice(THREAD_ID_PREFIX.length));
    return root || null;
  } catch {
    return null;
  }
}

export function stripAngles(messageId: string) {
  return messageId.trim().replace(/^<+/, "").replace(/>+$/, "");
}

export function withAngles(messageId: string) {
  return `<${stripAngles(messageId)}>`;
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}
