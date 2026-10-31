import { describe, expect, it } from "vitest";
import { buildImapSearch, mergeConditions } from "@/utils/imap/search";

describe("buildImapSearch", () => {
  it("translates Gmail-style operators", () => {
    expect(
      buildImapSearch('from:news@x.com subject:"Weekly digest" is:unread'),
    ).toEqual({
      from: "news@x.com",
      subject: "Weekly digest",
      seen: false,
    });
  });

  it("parses after/before dates in Gmail's slash and epoch forms", () => {
    const search = buildImapSearch("after:2024/01/31 before:1706745600");
    expect(search.since).toEqual(new Date("2024-01-31"));
    expect(search.before).toEqual(new Date(1_706_745_600_000));
  });

  it("uses full text for free words and negates with a minus", () => {
    expect(buildImapSearch("invoice -from:spam@x.com")).toEqual({
      text: "invoice",
      not: { from: "spam@x.com" },
    });
  });

  it("passes the query through X-GM-RAW on Gmail", () => {
    expect(buildImapSearch("label:foo older_than:2d", { gmail: true })).toEqual(
      { gmraw: "label:foo older_than:2d" },
    );
  });

  it("matches everything for an empty query", () => {
    expect(buildImapSearch("  ")).toEqual({ all: true });
  });
});

describe("free text", () => {
  it("searches several words as one phrase", () => {
    expect(buildImapSearch("weekly digest")).toEqual({ text: "weekly digest" });
  });
});

describe("mergeConditions", () => {
  it("keeps repeated keys instead of overwriting them", () => {
    const merged = mergeConditions([{ text: "a" }, { text: "b" }]);
    expect(merged).toEqual({ text: "b", or: [{ text: "a" }] });
  });
});
