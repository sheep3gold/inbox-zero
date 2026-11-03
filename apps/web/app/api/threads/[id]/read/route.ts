import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";

const paramsSchema = z.object({ id: z.string().min(1) });

// Stable HTTP mutation for native clients; account ownership is enforced by
// withEmailProvider before the provider is called. Repeated reads are idempotent.
export const POST = withEmailProvider(
  "threads/read",
  async (request, context) => {
    const { id } = paramsSchema.parse(await context.params);
    try {
      await request.emailProvider.markReadThread(id, true);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 },
        );
      }
      throw error;
    }
    return NextResponse.json({ success: true });
  },
);
