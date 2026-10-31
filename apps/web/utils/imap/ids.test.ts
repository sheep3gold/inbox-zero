import { describe, expect, it } from "vitest";
import {
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
} from "@/utils/imap/ids";

describe("IMAP message ids", () => {
  it("round-trips non-ASCII folder paths and Message-IDs", () => {
    const ref = {
      mailbox: "&XfJT0ZAB-",
      uidValidity: "1700000000",
      uid: 42,
      rfcMessageId: "abc.123@qq.com",
    };
    const id = encodeMessageId({ ...ref, rfcMessageId: "<abc.123@qq.com>" });
    expect(id).toMatch(/^[\w.-]+$/);
    expect(decodeMessageId(id)).toEqual(ref);
  });

  it("round-trips a message without a Message-ID", () => {
    const id = encodeMessageId({
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 7,
    });
    expect(decodeMessageId(id)).toEqual({
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 7,
    });
  });

  it("rejects ids from other providers", () => {
    expect(decodeMessageId("18c2f1a9b3e")).toBeNull();
    expect(decodeMessageId("imap1_x.1.SU5CT1g.")).toBeNull();
  });

  it("round-trips thread ids", () => {
    expect(decodeThreadId(encodeThreadId("<root@x.com>"))).toBe("root@x.com");
    expect(decodeThreadId("AAMkAG")).toBeNull();
  });
});
