import { describe, expect, it } from "vitest";
import { getRootMessageId, parseMessageIdList } from "@/utils/imap/thread";

describe("getRootMessageId", () => {
  it("uses the first References entry so every reply shares the root", () => {
    const root = getRootMessageId({
      references: "<root@a.com> <reply1@b.com>",
      inReplyTo: "<reply1@b.com>",
      messageId: "<reply2@a.com>",
    });
    expect(root).toBe("root@a.com");
  });

  it("falls back to In-Reply-To when References is missing", () => {
    // Some clients (older Outlook, some mobile apps) only set In-Reply-To.
    expect(
      getRootMessageId({
        inReplyTo: "<parent@x.com>",
        messageId: "<child@x.com>",
      }),
    ).toBe("parent@x.com");
  });

  it("uses the message's own id for a new conversation", () => {
    expect(getRootMessageId({ messageId: "<new@x.com>" })).toBe("new@x.com");
  });

  it("returns undefined without any id", () => {
    expect(getRootMessageId({})).toBeUndefined();
  });

  it("puts a message and its replies in the same thread", () => {
    const original = getRootMessageId({ messageId: "<a@x.com>" });
    const reply = getRootMessageId({
      references: "<a@x.com>",
      inReplyTo: "<a@x.com>",
      messageId: "<b@y.com>",
    });
    const replyToReply = getRootMessageId({
      references: "<a@x.com> <b@y.com>",
      inReplyTo: "<b@y.com>",
      messageId: "<c@x.com>",
    });
    expect(new Set([original, reply, replyToReply]).size).toBe(1);
  });
});

describe("parseMessageIdList", () => {
  it("parses folded, bracketed ids", () => {
    expect(parseMessageIdList("<a@x>\r\n <b@y>\t<c@z>")).toEqual([
      "a@x",
      "b@y",
      "c@z",
    ]);
  });

  it("parses bare ids separated by whitespace or commas", () => {
    expect(parseMessageIdList("a@x, b@y c@z")).toEqual(["a@x", "b@y", "c@z"]);
  });
});
