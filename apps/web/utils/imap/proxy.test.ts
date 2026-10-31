import { describe, expect, it } from "vitest";
import { resolveMailProxy } from "@/utils/imap/proxy";

describe("resolveMailProxy", () => {
  const proxy = "http://172.17.0.1:7891";

  it("matches exact hosts and suffixes", () => {
    const hosts = "imap.gmail.com, .gmail.com";
    expect(resolveMailProxy("IMAP.gmail.com", proxy, hosts)).toBe(proxy);
    expect(resolveMailProxy("smtp.gmail.com", proxy, hosts)).toBe(proxy);
    expect(resolveMailProxy("imap.qq.com", proxy, hosts)).toBeUndefined();
    // A suffix must not match a lookalike domain.
    expect(resolveMailProxy("evilgmail.com", proxy, hosts)).toBeUndefined();
  });

  it("proxies every host with *", () => {
    expect(resolveMailProxy("imap.qq.com", proxy, "*")).toBe(proxy);
  });

  it("is off unless both settings are present", () => {
    expect(resolveMailProxy("imap.gmail.com", undefined, "*")).toBeUndefined();
    expect(resolveMailProxy("imap.gmail.com", proxy, "")).toBeUndefined();
  });
});
