import type { ImapSecurity } from "@/utils/imap/types";

export type ImapPreset = {
  id: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: ImapSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: ImapSecurity;
  /** Email domains that are known to use this preset. */
  domains: string[];
  /** Most providers refuse the web login password over IMAP. */
  passwordHint: string;
};

export const IMAP_PRESETS: ImapPreset[] = [
  {
    id: "netease-qiye",
    name: "NetEase Enterprise Mail (网易企业邮)",
    imapHost: "imap.qiye.163.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.qiye.163.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    domains: [],
    passwordHint:
      "Use a client authorization code (客户端授权码) from Settings → Client settings, not your login password.",
  },
  {
    id: "netease-163",
    name: "NetEase 163 Mail",
    imapHost: "imap.163.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    domains: ["163.com"],
    passwordHint:
      "Enable IMAP/SMTP in settings and use the authorization code (授权码).",
  },
  {
    id: "qq",
    name: "QQ Mail",
    imapHost: "imap.qq.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    domains: ["qq.com", "foxmail.com", "vip.qq.com"],
    passwordHint:
      "Enable IMAP/SMTP in QQ Mail settings and use the authorization code (授权码).",
  },
  {
    id: "gmail",
    name: "Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    domains: ["gmail.com", "googlemail.com"],
    passwordHint:
      "Use an app password (Google Account → Security → App passwords). 2-Step Verification must be on.",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    domains: ["icloud.com", "me.com", "mac.com"],
    passwordHint: "Use an app-specific password from appleid.apple.com.",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    domains: ["fastmail.com"],
    passwordHint: "Use an app password from Settings → Privacy & Security.",
  },
];

export function getImapPreset(id: string): ImapPreset | undefined {
  return IMAP_PRESETS.find((preset) => preset.id === id);
}

export function findImapPresetForEmail(email: string): ImapPreset | undefined {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return;
  return IMAP_PRESETS.find((preset) => preset.domains.includes(domain));
}
