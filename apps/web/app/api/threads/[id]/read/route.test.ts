import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  markReadThread: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function read() {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/read", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the thread read", async () => {
    mockEmailProvider.markReadThread.mockResolvedValue(undefined);

    const response = await read();

    expect(mockEmailProvider.markReadThread).toHaveBeenCalledWith(
      "thread-1",
      true,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it("returns 404 when the thread no longer exists", async () => {
    mockEmailProvider.markReadThread.mockRejectedValue(
      new Error("Requested entity was not found."),
    );

    const response = await read();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Thread not found",
    });
  });

  it("returns 404 when Outlook reports the item as missing", async () => {
    mockEmailProvider.markReadThread.mockRejectedValue(
      Object.assign(new Error("item missing"), { code: "ErrorItemNotFound" }),
    );

    const response = await read();

    expect(response.status).toBe(404);
  });

  it("lets other provider failures reach the middleware's error mapping", async () => {
    const providerError = new Error("Provider unavailable");
    mockEmailProvider.markReadThread.mockRejectedValue(providerError);

    await expect(read()).rejects.toThrow(providerError);
  });
});
