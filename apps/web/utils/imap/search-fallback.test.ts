import { describe, expect, it } from "vitest";
import {
  FULL_SEARCH_SUPPORT,
  matchesSearch,
  needsClientFilter,
  probeSearchSupport,
  serverPrefilter,
} from "@/utils/imap/search-fallback";

const message = {
  uid: 7,
  flags: new Set(["\\Seen"]),
  internalDate: new Date("2026-10-20T08:00:00Z"),
  envelope: {
    subject: "周报 Weekly digest",
    from: [{ name: "Acme News", address: "news@acme.example" }],
    to: [{ name: "", address: "me@zxytech.cn" }],
  },
  headers: Buffer.from(
    "Message-ID: <m2@acme.example>\r\nReferences: <root@acme.example>\r\n <m1@acme.example>\r\nContent-Type: multipart/mixed; boundary=x\r\n",
  ),
};

describe("probeSearchSupport", () => {
  const target = {
    uid: 7,
    messageId: "<m2@acme.example>",
    fromAddress: "news@acme.example",
  };

  it("detects a server that returns nothing for FROM and plain HEADER ids", async () => {
    // NetEase: FROM/TEXT return no results, HEADER only with angle brackets.
    const support = await probeSearchSupport(target, async (query) =>
      query.header?.["message-id"] === "<m2@acme.example>" ? [7] : [],
    );
    expect(support).toEqual({
      header: true,
      address: false,
      partialAddress: false,
      subject: false,
      text: false,
    });
  });

  it("detects a server whose TEXT matches everything and FROM needs the full address", async () => {
    // QQ Mail.
    const support = await probeSearchSupport(
      { ...target, subject: "Weekly digest" },
      async (query) => {
        if (query.text) return [1, 2, 7];
        if (query.from === "news@acme.example") return [7];
        if (query.subject === "Weekly") return [7];
        return [];
      },
    );
    expect(support).toEqual({
      header: false,
      address: true,
      partialAddress: false,
      subject: true,
      text: false,
    });
  });

  it("trusts a server that answers correctly", async () => {
    const support = await probeSearchSupport(
      { ...target, subject: "Weekly digest" },
      async (query) => (JSON.stringify(query).includes("zq") ? [] : [7]),
    );
    expect(support).toEqual(FULL_SEARCH_SUPPORT);
  });
});

describe("needsClientFilter", () => {
  const netease = {
    header: true,
    address: false,
    partialAddress: false,
    subject: false,
    text: false,
  };

  it("keeps flag, date and UID searches on the server", () => {
    expect(
      needsClientFilter(
        { seen: false, since: new Date(), uid: "5:*" },
        netease,
      ),
    ).toBe(false);
  });

  it("keeps full-address searches on a server that only matches full addresses", () => {
    const qq = { ...netease, address: true, subject: true };
    expect(needsClientFilter({ from: "a@b.com" }, qq)).toBe(false);
    expect(needsClientFilter({ from: "b.com" }, qq)).toBe(true);
  });

  it("moves address searches nested in OR/NOT to the client", () => {
    expect(
      needsClientFilter({ or: [{ from: "a" }, { to: "a" }] }, netease),
    ).toBe(true);
    expect(needsClientFilter({ not: { from: "a" } }, netease)).toBe(true);
    expect(
      needsClientFilter({ header: { "message-id": "<a@b>" } }, netease),
    ).toBe(false);
  });
});

describe("serverPrefilter", () => {
  it("keeps only keys the server handles", () => {
    const since = new Date("2026-10-01");
    expect(serverPrefilter({ from: "a", seen: false, since })).toEqual({
      seen: false,
      since,
    });
    expect(serverPrefilter({ from: "a" })).toEqual({ all: true });
  });
});

describe("matchesSearch", () => {
  it("matches addresses, domains and subjects case-insensitively", () => {
    expect(matchesSearch({ from: "ACME.example" }, message)).toBe(true);
    expect(matchesSearch({ to: "zxytech.cn" }, message)).toBe(true);
    expect(matchesSearch({ subject: "周报" }, message)).toBe(true);
    expect(matchesSearch({ from: "other.example" }, message)).toBe(false);
  });

  it("matches thread headers with or without angle brackets", () => {
    expect(
      matchesSearch(
        {
          or: [
            { header: { "message-id": "<root@acme.example>" } },
            { header: { references: "<root@acme.example>" } },
          ],
        },
        message,
      ),
    ).toBe(true);
    expect(
      matchesSearch({ header: { "message-id": "m2@acme.example" } }, message),
    ).toBe(true);
    expect(
      matchesSearch({ header: { "content-type": "multipart/mixed" } }, message),
    ).toBe(true);
  });

  it("applies flags, dates and negation", () => {
    expect(matchesSearch({ seen: true, flagged: false }, message)).toBe(true);
    expect(matchesSearch({ seen: false }, message)).toBe(false);
    expect(
      matchesSearch({ since: new Date("2026-10-20T23:00:00Z") }, message),
    ).toBe(true);
    expect(matchesSearch({ before: new Date("2026-10-20") }, message)).toBe(
      false,
    );
    expect(matchesSearch({ not: { from: "acme" } }, message)).toBe(false);
  });
});
