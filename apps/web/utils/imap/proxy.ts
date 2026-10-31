import { env } from "@/env";

/**
 * Some networks can't reach a mail provider directly (Gmail from mainland
 * China, for example). IMAP_PROXY_URL is an HTTP CONNECT or SOCKS proxy used
 * for hosts matching IMAP_PROXY_HOSTS: a comma-separated list of host names
 * or ".suffix" entries, or "*" for every host.
 */
export function getMailProxyForHost(host: string): string | undefined {
  return resolveMailProxy(host, env.IMAP_PROXY_URL, env.IMAP_PROXY_HOSTS);
}

export function resolveMailProxy(
  host: string,
  proxyUrl: string | undefined,
  proxyHosts: string | undefined,
): string | undefined {
  if (!proxyUrl || !proxyHosts) return;
  const name = host.trim().toLowerCase();
  const matches = proxyHosts
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      if (entry.startsWith(".")) return name.endsWith(entry);
      return name === entry;
    });
  return matches ? proxyUrl : undefined;
}
