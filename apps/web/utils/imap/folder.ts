import type { ListResponse } from "imapflow";

export type MailboxRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "junk"
  | "archive"
  | "all"
  | "flagged"
  | "important";

type MailboxLike = Pick<ListResponse, "path" | "flags"> & {
  specialUse?: string;
};

const SPECIAL_USE_ROLES: Record<string, MailboxRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Flagged": "flagged",
  "\\Important": "important",
};

/** Gmail-style system label ids, which the rest of the app understands. */
export const ROLE_LABEL_IDS: Partial<Record<MailboxRole, string>> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  junk: "SPAM",
  important: "IMPORTANT",
};

export const UNREAD_LABEL_ID = "UNREAD";
export const STARRED_LABEL_ID = "STARRED";

/**
 * Folders are identified by RFC 6154 SPECIAL-USE attributes. When a server
 * does not send them, imapflow fills `specialUse` from well-known names,
 * including localized ones such as 已发送 and 垃圾邮件, so we never match on
 * English folder names here.
 */
export function getMailboxRole(mailbox: MailboxLike): MailboxRole | undefined {
  if (mailbox.path.toUpperCase() === "INBOX") return "inbox";
  if (mailbox.specialUse) {
    const role = SPECIAL_USE_ROLES[mailbox.specialUse];
    if (role) return role;
  }
  for (const flag of mailbox.flags ?? []) {
    const role = SPECIAL_USE_ROLES[flag];
    if (role) return role;
  }
  return LOCALIZED_NAME_ROLES[mailbox.path];
}

// Names imapflow's own hints miss, used only when the server sends no
// SPECIAL-USE attribute. NetEase 163/126/yeah.net and qiye use these.
const LOCALIZED_NAME_ROLES: Record<string, MailboxRole> = {
  已删除: "trash",
  已删除邮件: "trash",
  草稿箱: "drafts",
  已发送: "sent",
  垃圾邮件: "junk",
  归档: "archive",
};

export function isSelectable(mailbox: MailboxLike) {
  return (
    !mailbox.flags?.has("\\Noselect") && !mailbox.flags?.has("\\NonExistent")
  );
}

export type FolderMap = {
  byRole: Partial<Record<MailboxRole, string>>;
  selectable: MailboxLike[];
  all: MailboxLike[];
  delimiter: string;
};

export function buildFolderMap(
  mailboxes: Array<MailboxLike & { delimiter?: string }>,
): FolderMap {
  const byRole: FolderMap["byRole"] = {};
  for (const mailbox of mailboxes) {
    if (!isSelectable(mailbox)) continue;
    const role = getMailboxRole(mailbox);
    // The first match wins; servers list the canonical folder first.
    if (role && !byRole[role]) byRole[role] = mailbox.path;
  }
  byRole.inbox ??= "INBOX";

  return {
    byRole,
    selectable: mailboxes.filter(isSelectable),
    all: mailboxes,
    delimiter: mailboxes.find((mailbox) => mailbox.delimiter)?.delimiter || "/",
  };
}

export function getRoleForPath(
  folders: FolderMap,
  path: string,
): MailboxRole | undefined {
  for (const [role, rolePath] of Object.entries(folders.byRole)) {
    if (rolePath === path) return role as MailboxRole;
  }
  return;
}

/** A folder that acts like a label: not a system folder and not a container. */
export function isUserFolder(folders: FolderMap, mailbox: MailboxLike) {
  if (!isSelectable(mailbox)) return false;
  if (getRoleForPath(folders, mailbox.path)) return false;
  // Gmail's own "[Gmail]" namespace only holds system folders.
  if (/^\[(Gmail|Google Mail)\]/i.test(mailbox.path)) return false;
  return true;
}

/** The label id a message gets for living in `path`. */
export function getFolderLabelId(folders: FolderMap, path: string) {
  const role = getRoleForPath(folders, path);
  if (role) return ROLE_LABEL_IDS[role];
  if (role === undefined && /^\[(Gmail|Google Mail)\]/i.test(path)) return;
  return path;
}

/** Resolves a label id (system id like "INBOX" or a folder path) to a folder path. */
export function resolveLabelToPath(
  folders: FolderMap,
  labelId: string,
): string | undefined {
  for (const [role, systemId] of Object.entries(ROLE_LABEL_IDS)) {
    if (systemId === labelId) return folders.byRole[role as MailboxRole];
  }
  return folders.selectable.find((mailbox) => mailbox.path === labelId)?.path;
}

/** Human-readable folder name: the path with the server delimiter shown as "/". */
export function getFolderDisplayName(path: string, delimiter: string) {
  const withoutGmailPrefix = path.replace(/^\[(Gmail|Google Mail)\]\//i, "");
  if (!delimiter || delimiter === "/") return withoutGmailPrefix;
  return withoutGmailPrefix.split(delimiter).join("/");
}

/** Turns a "/"-nested label name into a folder path for this server. */
export function toFolderPath(name: string, delimiter: string) {
  const parts = name
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.join(delimiter || "/");
}

export function findFolderByName(
  folders: FolderMap,
  name: string,
): MailboxLike | undefined {
  const wanted = name.trim().toLowerCase();
  const wantedPath = toFolderPath(name, folders.delimiter).toLowerCase();
  return folders.selectable.find((mailbox) => {
    const path = mailbox.path.toLowerCase();
    return (
      path === wantedPath ||
      path === wanted ||
      getFolderDisplayName(mailbox.path, folders.delimiter).toLowerCase() ===
        wanted
    );
  });
}
