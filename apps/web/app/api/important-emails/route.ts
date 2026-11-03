import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export const maxDuration = 30;

export const GET = withAuth(
  withEmailProvider(
    "important-emails",
    async (request) => {
      const { emailProvider } = request;
      const { emailAccountId } = request.auth;

      const { searchParams } = new URL(request.url);
      const limit = Number.parseInt(searchParams.get("limit") || "20", 10);

      // Find the "重要邮件识别" rule for this account
      const rule = await prisma.rule.findFirst({
        where: {
          emailAccountId,
          name: "重要邮件识别",
          enabled: true,
        },
      });

      if (!rule) {
        return NextResponse.json({ threads: [], nextPageToken: "" });
      }

      // Find thread IDs from ExecutedRule where this rule was applied
      const executedRules = await prisma.executedRule.findMany({
        where: {
          ruleId: rule.id,
          status: "APPLIED",
          emailAccountId,
        },
        select: {
          threadId: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
      });

      const threadIds = executedRules.map((er) => er.threadId);

      if (threadIds.length === 0) {
        return NextResponse.json({ threads: [], nextPageToken: "" });
      }

      // Load threads by IDs using emailProvider
      try {
        const threads = [];
        for (const threadId of threadIds) {
          try {
            const thread = await emailProvider.getThread(threadId);
            if (thread) {
              threads.push(thread);
            }
          } catch (error) {
            // Skip threads that fail to load
            request.logger.warn("Failed to load thread", { threadId, error });
          }
        }

        return NextResponse.json({ threads });
      } catch (error) {
        request.logger.error("Error fetching important emails", {
          error,
          emailAccountId,
        });
        return NextResponse.json(
          { error: "Failed to fetch important emails" },
          { status: 500 },
        );
      }
    },
    { requestTiming: {} },
  ),
);
