import { ImapFlow, type ListResponse } from "imapflow";
import type {
  ImapConnectionConfig,
  ImapCredentialConfig,
} from "@/utils/imap/types";
import { createScopedLogger } from "@/utils/logger";
import type { SearchSupport } from "@/utils/imap/search-fallback";

const logger = createScopedLogger("imap/client");

const CONNECT_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 120_000;
const POOL_IDLE_CLOSE_MS = 60_000;
const MAILBOX_LIST_TTL_MS = 60_000;

// NetEase (163 / qiye.163.com) rejects SELECT with "Unsafe Login" unless the
// client identifies itself with the IMAP ID command (RFC 2971) after login.
const IMAP_CLIENT_INFO = {
  name: "Inbox Zero",
  version: "1.0.0",
  vendor: "Inbox Zero",
  "support-url": "https://www.getinboxzero.com",
};

export function createImapClient(config: ImapConnectionConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecurity === "tls",
    // STARTTLS must succeed; never fall back to a plaintext login.
    doSTARTTLS: config.imapSecurity === "starttls" ? true : undefined,
    auth: { user: config.username, pass: config.password },
    clientInfo: IMAP_CLIENT_INFO,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

/** One IMAP connection plus the folder list, shared by everything that talks to one account. */
export class ImapSession {
  private mailboxes?: { list: ListResponse[]; fetchedAt: number };

  readonly client: ImapFlow;
  /** Which SEARCH keys this server honors; measured on first use. */
  searchSupport?: Promise<SearchSupport>;

  /** Identifies the mailbox for process-wide caches. */
  readonly cacheKey: string;

  constructor(client: ImapFlow, cacheKey: string) {
    this.client = client;
    this.cacheKey = cacheKey;
  }

  get usable() {
    return this.client.usable;
  }

  hasCapability(name: string) {
    return this.client.capabilities.has(name);
  }

  /** Gmail exposes labels as folders and adds X-GM-* extensions. */
  get isGmail() {
    return this.hasCapability("X-GM-EXT-1");
  }

  async listMailboxes({ fresh = false } = {}): Promise<ListResponse[]> {
    if (
      !fresh &&
      this.mailboxes &&
      Date.now() - this.mailboxes.fetchedAt < MAILBOX_LIST_TTL_MS
    ) {
      return this.mailboxes.list;
    }
    const list = await this.client.list();
    this.mailboxes = { list, fetchedAt: Date.now() };
    return list;
  }

  invalidateMailboxes() {
    this.mailboxes = undefined;
  }

  async withMailbox<T>(
    path: string,
    fn: (mailbox: MailboxInfo) => Promise<T>,
    { readOnly = false }: { readOnly?: boolean } = {},
  ): Promise<T> {
    const lock = await this.client.getMailboxLock(path, { readOnly });
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) throw new Error(`Failed to open IMAP folder ${path}`);
      return await fn({
        path: mailbox.path,
        uidValidity: mailbox.uidValidity,
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
        permanentFlags: mailbox.permanentFlags,
      });
    } finally {
      lock.release();
    }
  }
}

export type MailboxInfo = {
  path: string;
  uidValidity: bigint;
  uidNext: number;
  exists: number;
  permanentFlags?: Set<string>;
};

type PoolEntry = {
  version: string;
  session: Promise<ImapSession>;
  users: number;
  closeTimer?: ReturnType<typeof setTimeout>;
};

const pool = new Map<string, PoolEntry>();

/**
 * Runs `fn` on a pooled connection for the account. Connections are reused
 * across calls in the same process and closed after a minute of inactivity,
 * which keeps us well under per-account connection limits (Gmail allows 15).
 */
export async function withImapSession<T>(
  config: ImapCredentialConfig,
  fn: (session: ImapSession) => Promise<T>,
): Promise<T> {
  const entry = acquire(config);
  try {
    const session = await entry.session;
    return await fn(session);
  } finally {
    release(config.emailAccountId, entry);
  }
}

/** Opens a dedicated connection, for one-off checks that must not reuse pooled state. */
export async function withImapConnection<T>(
  config: ImapConnectionConfig,
  fn: (session: ImapSession) => Promise<T>,
): Promise<T> {
  const client = createImapClient(config);
  await client.connect();
  try {
    return await fn(
      new ImapSession(client, `${config.username}@${config.imapHost}`),
    );
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function acquire(config: ImapCredentialConfig): PoolEntry {
  const existing = pool.get(config.emailAccountId);
  if (existing && existing.version === config.version) {
    existing.users++;
    if (existing.closeTimer) clearTimeout(existing.closeTimer);
    existing.closeTimer = undefined;
    return existing;
  }
  if (existing) discard(config.emailAccountId, existing);

  const entry: PoolEntry = {
    version: config.version,
    users: 1,
    session: connectSession(config),
  };
  entry.session.catch(() => {
    if (pool.get(config.emailAccountId) === entry) {
      pool.delete(config.emailAccountId);
    }
  });
  pool.set(config.emailAccountId, entry);
  return entry;
}

async function connectSession(config: ImapCredentialConfig) {
  const client = createImapClient(config);
  client.on("error", (error) => {
    logger.warn("IMAP connection error", {
      emailAccountId: config.emailAccountId,
      error,
    });
  });
  client.on("close", () => {
    const entry = pool.get(config.emailAccountId);
    if (entry?.version === config.version) {
      entry.session
        .then((session) => {
          if (session.client === client) pool.delete(config.emailAccountId);
        })
        .catch(() => undefined);
    }
  });
  await client.connect();
  return new ImapSession(client, config.emailAccountId);
}

function release(emailAccountId: string, entry: PoolEntry) {
  entry.users = Math.max(0, entry.users - 1);
  if (entry.users > 0) return;
  entry.closeTimer = setTimeout(() => {
    if (entry.users === 0) discard(emailAccountId, entry);
  }, POOL_IDLE_CLOSE_MS);
  entry.closeTimer.unref?.();
}

function discard(emailAccountId: string, entry: PoolEntry) {
  if (pool.get(emailAccountId) === entry) pool.delete(emailAccountId);
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  entry.session
    .then((session) =>
      session.client.logout().catch(() => session.client.close()),
    )
    .catch(() => undefined);
}

/** Drops a broken pooled connection so the next call reconnects. */
export function resetImapSession(emailAccountId: string) {
  const entry = pool.get(emailAccountId);
  if (entry) discard(emailAccountId, entry);
}
