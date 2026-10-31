import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { type RequestWithLogger, withError } from "@/utils/middleware";
import { pollAllImapAccounts } from "@/utils/imap/poll";

export const maxDuration = 300;

// IMAP has no push notifications, so new mail is found by polling. Run this
// every minute from cron (see docker-compose.yml).
export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/cron/imap-poll"));
    return new Response("Unauthorized", { status: 401 });
  }
  return pollAccounts(request);
});

export const POST = withError("cron/imap-poll", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/imap-poll"),
    );
    return new Response("Unauthorized", { status: 401 });
  }
  return pollAccounts(request);
});

async function pollAccounts(request: RequestWithLogger) {
  const results = await pollAllImapAccounts(request.logger);
  return NextResponse.json({
    accounts: results.length,
    processed: results.reduce((total, result) => total + result.processed, 0),
    failed: results.filter((result) => result.error).length,
  });
}
