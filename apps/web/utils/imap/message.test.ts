import { describe, expect, it } from "vitest";
import { buildFolderMap } from "@/utils/imap/folder";
import { decodeMessageId, decodeThreadId } from "@/utils/imap/ids";
import { parseImapMessage } from "@/utils/imap/message";

const folders = buildFolderMap(
  [
    { path: "INBOX" },
    { path: "已发送", specialUse: "\\Sent" },
    { path: "Receipts" },
  ].map((box) => ({ ...box, flags: new Set<string>(), delimiter: "/" })),
);

const reply = [
  "From: =?UTF-8?B?5byg5LiJ?= <zhang@qiye.example.cn>",
  "To: me@example.com, Other <other@example.com>",
  "Cc: cc@example.com",
  "Subject: =?UTF-8?B?UmU6IOS8muiuruWuieaOkg==?=",
  "Date: Tue, 01 Oct 2024 10:00:00 +0800",
  "Message-ID: <reply-2@qiye.example.cn>",
  "In-Reply-To: <reply-1@example.com>",
  "References: <root@example.com>\r\n <reply-1@example.com>",
  "List-Unsubscribe: <https://example.com/u?id=1>,\r\n <mailto:u@example.com>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: multipart/alternative; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("周三下午三点可以。\n\n> earlier text").toString("base64"),
  "--b2",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<p>周三下午三点可以。</p>",
  "--b2--",
  "--b1",
  'Content-Type: application/pdf; name="agenda.pdf"',
  'Content-Disposition: attachment; filename="agenda.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 test").toString("base64"),
  "--b1--",
  "",
].join("\r\n");

describe("parseImapMessage", () => {
  it("parses headers, bodies, threading and attachments", async () => {
    const message = await parseImapMessage(
      {
        source: Buffer.from(reply),
        uid: 15,
        mailbox: "INBOX",
        uidValidity: BigInt(1700),
        flags: new Set(["\\Flagged"]),
        internalDate: new Date("2024-10-01T02:00:05Z"),
      },
      folders,
    );

    expect(message.headers.from).toBe("张三 <zhang@qiye.example.cn>");
    expect(message.headers.to).toBe(
      "me@example.com, Other <other@example.com>",
    );
    expect(message.headers.cc).toBe("cc@example.com");
    expect(message.subject).toBe("Re: 会议安排");
    expect(message.headers["message-id"]).toBe("<reply-2@qiye.example.cn>");
    expect(message.headers["in-reply-to"]).toBe("<reply-1@example.com>");
    expect(message.headers.references).toBe(
      "<root@example.com> <reply-1@example.com>",
    );
    expect(message.headers["list-unsubscribe"]).toBe(
      "<https://example.com/u?id=1>, <mailto:u@example.com>",
    );
    expect(message.headers["list-unsubscribe-post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(message.textPlain).toContain("周三下午三点可以");
    expect(message.textHtml).toContain("<p>周三下午三点可以。</p>");
    expect(message.snippet.startsWith("周三下午三点可以。")).toBe(true);
    expect(message.attachments).toMatchObject([
      {
        attachmentId: "0",
        filename: "agenda.pdf",
        mimeType: "application/pdf",
      },
    ]);
    expect(message.internalDate).toBe(
      String(new Date("2024-10-01T02:00:05Z").getTime()),
    );

    expect(decodeThreadId(message.threadId)).toBe("root@example.com");
    expect(decodeMessageId(message.id)).toEqual({
      mailbox: "INBOX",
      uidValidity: "1700",
      uid: 15,
      rfcMessageId: "reply-2@qiye.example.cn",
    });
    expect(message.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "UNREAD", "STARRED"]),
    );
  });

  it("labels sent mail and user folders", async () => {
    const source = Buffer.from(
      "From: me@example.com\r\nTo: a@b.com\r\nSubject: hi\r\nMessage-ID: <s1@example.com>\r\n\r\nhello",
    );
    const sent = await parseImapMessage(
      {
        source,
        uid: 1,
        mailbox: "已发送",
        uidValidity: BigInt(1),
        flags: new Set(["\\Seen"]),
      },
      folders,
    );
    expect(sent.labelIds).toEqual(["SENT"]);

    const filed = await parseImapMessage(
      {
        source,
        uid: 2,
        mailbox: "Receipts",
        uidValidity: BigInt(1),
        flags: new Set(["\\Seen"]),
      },
      folders,
    );
    expect(filed.labelIds).toEqual(["Receipts"]);
  });

  it("maps Gmail X-GM-LABELS to label ids", async () => {
    const message = await parseImapMessage(
      {
        source: Buffer.from("From: a@b.com\r\nSubject: x\r\n\r\nbody"),
        uid: 3,
        mailbox: "INBOX",
        uidValidity: BigInt(1),
        flags: new Set(["\\Seen"]),
        gmailLabels: new Set(["\\Important", "Receipts"]),
      },
      folders,
    );
    expect(message.labelIds).toEqual(["INBOX", "IMPORTANT", "Receipts"]);
  });

  it("gives a message without Message-ID its own thread", async () => {
    const message = await parseImapMessage(
      {
        source: Buffer.from("From: a@b.com\r\nSubject: x\r\n\r\nbody"),
        uid: 9,
        mailbox: "INBOX",
        uidValidity: BigInt(5),
      },
      folders,
    );
    expect(decodeThreadId(message.threadId)).toBe("uid:INBOX:5:9");
  });
});
