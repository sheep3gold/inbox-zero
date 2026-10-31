import { describe, expect, it } from "vitest";
import { describeError, isPrivateAddress } from "@/utils/imap/connection-test";

describe("describeError", () => {
  it("explains dual-stack connect failures that have no message", () => {
    // Node's dual-stack connect rejects with an AggregateError without a message.
    const error = Object.assign(Object.create(AggregateError.prototype), {
      code: "ETIMEDOUT",
      errors: [
        { code: "ETIMEDOUT", address: "173.194.202.108" },
        { code: "ENETUNREACH", address: "2607:f8b0:400e:c05::6c" },
      ],
    });
    expect(describeError(error)).toBe(
      "Could not reach the server: ETIMEDOUT (ETIMEDOUT 173.194.202.108, ENETUNREACH 2607:f8b0:400e:c05::6c)",
    );
  });

  it("points rejected logins to app passwords", () => {
    const error = Object.assign(new Error("Command failed"), {
      responseText: "LOGIN Login error user name or password error",
    });
    expect(describeError(error)).toMatch(/app password or authorization code/);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.17.0.1",
    "192.168.1.1",
    "100.65.1.1",
    "::1",
  ])("%s is private", (address) =>
    expect(isPrivateAddress(address)).toBe(true));
  it("public addresses are allowed", () => {
    expect(isPrivateAddress("123.58.177.1")).toBe(false);
  });
});
