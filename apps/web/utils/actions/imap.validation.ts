import { z } from "zod";
import { imapSecuritySchema } from "@/utils/imap/types";

const hostSchema = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, "Enter a host name such as imap.example.com");

const portSchema = z.number().int().min(1).max(65_535);

export const imapConnectionBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
  imapHost: hostSchema,
  imapPort: portSchema,
  imapSecurity: imapSecuritySchema,
  smtpHost: hostSchema,
  smtpPort: portSchema,
  smtpSecurity: imapSecuritySchema,
});
export type ImapConnectionBody = z.infer<typeof imapConnectionBody>;
