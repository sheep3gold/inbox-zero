import { describe, expect, it } from "vitest";
import {
  buildFolderMap,
  findFolderByName,
  getFolderDisplayName,
  getFolderLabelId,
  isUserFolder,
  resolveLabelToPath,
  toFolderPath,
} from "@/utils/imap/folder";

type Box = {
  path: string;
  specialUse?: string;
  flags?: string[];
  delimiter?: string;
};

function mailboxes(boxes: Box[]) {
  return boxes.map((box) => ({
    path: box.path,
    specialUse: box.specialUse,
    flags: new Set(box.flags ?? []),
    delimiter: box.delimiter ?? "/",
  }));
}

describe("buildFolderMap", () => {
  it("maps QQ Mail's Chinese folders by SPECIAL-USE, not by name", () => {
    // QQ lists folders under their Chinese names (IMAP UTF-7 decoded by imapflow).
    const folders = buildFolderMap(
      mailboxes([
        { path: "INBOX" },
        { path: "Sent Messages", specialUse: "\\Sent" },
        { path: "Drafts", specialUse: "\\Drafts" },
        { path: "Deleted Messages", specialUse: "\\Trash" },
        { path: "Junk", specialUse: "\\Junk" },
        { path: "其他文件夹/工作" },
      ]),
    );
    expect(folders.byRole).toMatchObject({
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      junk: "Junk",
    });
    expect(folders.byRole.archive).toBeUndefined();
  });

  it("maps NetEase folders named in Chinese", () => {
    const folders = buildFolderMap(
      mailboxes([
        { path: "INBOX" },
        { path: "已发送", specialUse: "\\Sent" },
        { path: "草稿箱", specialUse: "\\Drafts" },
        { path: "已删除", specialUse: "\\Trash" },
        { path: "垃圾邮件", specialUse: "\\Junk" },
        { path: "病毒文件夹" },
      ]),
    );
    expect(folders.byRole.sent).toBe("已发送");
    expect(folders.byRole.junk).toBe("垃圾邮件");
    expect(getFolderLabelId(folders, "已发送")).toBe("SENT");
    expect(getFolderLabelId(folders, "病毒文件夹")).toBe("病毒文件夹");
  });

  it("maps Gmail's [Gmail]/ folders and keeps them out of user labels", () => {
    const folders = buildFolderMap(
      mailboxes([
        { path: "INBOX" },
        { path: "[Gmail]", flags: ["\\Noselect"] },
        { path: "[Gmail]/All Mail", specialUse: "\\All" },
        { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
        { path: "[Gmail]/Spam", specialUse: "\\Junk" },
        { path: "[Gmail]/Trash", specialUse: "\\Trash" },
        { path: "[Gmail]/Starred", specialUse: "\\Flagged" },
        { path: "Receipts" },
      ]),
    );
    expect(folders.byRole.all).toBe("[Gmail]/All Mail");
    expect(folders.byRole.sent).toBe("[Gmail]/Sent Mail");
    expect(folders.selectable.map((box) => box.path)).not.toContain("[Gmail]");
    expect(
      folders.selectable
        .filter((box) => isUserFolder(folders, box))
        .map((box) => box.path),
    ).toEqual(["Receipts"]);
    expect(getFolderLabelId(folders, "[Gmail]/All Mail")).toBeUndefined();
    expect(getFolderDisplayName("[Gmail]/Starred", "/")).toBe("Starred");
  });

  it("recognizes NetEase folder names when SPECIAL-USE is missing", () => {
    const folders = buildFolderMap(
      mailboxes([{ path: "INBOX" }, { path: "已删除" }, { path: "草稿箱" }]),
    );
    expect(folders.byRole.trash).toBe("已删除");
    expect(folders.byRole.drafts).toBe("草稿箱");
  });

  it("falls back to SPECIAL-USE flags in the LIST response", () => {
    const folders = buildFolderMap(
      mailboxes([{ path: "INBOX" }, { path: "Outbox", flags: ["\\Sent"] }]),
    );
    expect(folders.byRole.sent).toBe("Outbox");
  });
});

describe("label ids and folder names", () => {
  const folders = buildFolderMap(
    mailboxes([
      { path: "INBOX", delimiter: "." },
      { path: "INBOX.Sent", specialUse: "\\Sent", delimiter: "." },
      { path: "INBOX.Projects.Alpha", delimiter: "." },
    ]),
  );

  it("resolves system label ids to the server's folder", () => {
    expect(resolveLabelToPath(folders, "SENT")).toBe("INBOX.Sent");
    expect(resolveLabelToPath(folders, "INBOX")).toBe("INBOX");
    expect(resolveLabelToPath(folders, "missing")).toBeUndefined();
  });

  it("uses the server delimiter for nested names", () => {
    expect(toFolderPath("Inbox Zero/Newsletter", ".")).toBe(
      "Inbox Zero.Newsletter",
    );
    expect(findFolderByName(folders, "INBOX/Projects/Alpha")?.path).toBe(
      "INBOX.Projects.Alpha",
    );
    expect(findFolderByName(folders, "inbox.projects.alpha")?.path).toBe(
      "INBOX.Projects.Alpha",
    );
  });
});
