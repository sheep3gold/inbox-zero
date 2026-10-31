import { describe, expect, it } from "vitest";
import {
  findImapPresetForEmail,
  getImapPreset,
  IMAP_PRESETS,
} from "@/utils/imap/presets";

describe("IMAP presets", () => {
  it.each([
    ["netease-qiye", "imap.qiye.163.com", "smtp.qiye.163.com"],
    ["qq", "imap.qq.com", "smtp.qq.com"],
    ["gmail", "imap.gmail.com", "smtp.gmail.com"],
  ])("%s uses implicit TLS on 993/465", (id, imapHost, smtpHost) => {
    expect(getImapPreset(id)).toMatchObject({
      imapHost,
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost,
      smtpPort: 465,
      smtpSecurity: "tls",
    });
  });

  it("detects presets from the address", () => {
    expect(findImapPresetForEmail("someone@qq.com")?.id).toBe("qq");
    expect(findImapPresetForEmail("Someone@Foxmail.com")?.id).toBe("qq");
    expect(findImapPresetForEmail("a@gmail.com")?.id).toBe("gmail");
    // Enterprise mail runs on custom domains, so it can't be detected.
    expect(findImapPresetForEmail("me@company.cn")).toBeUndefined();
  });

  it("has unique ids", () => {
    const ids = IMAP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
