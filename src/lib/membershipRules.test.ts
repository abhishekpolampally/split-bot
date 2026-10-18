import { describe, expect, it } from "vitest";
import { canClaim, isOwner } from "./membershipRules";
import { formatPhone, normalisePhone } from "./phone";

describe("group ownership", () => {
  it("only the creator owns the group", () => {
    expect(isOwner({ createdBy: "u1" }, { id: "u1" })).toBe(true);
    expect(isOwner({ createdBy: "u1" }, { id: "u2" })).toBe(false);
    expect(isOwner({ createdBy: null }, { id: "u1" })).toBe(false);
  });
});

describe("claiming a spot from an invite link", () => {
  const me = { phone: "+919876543210" };
  it("allows a spot saved for my number", () => {
    expect(canClaim({ userId: null, phone: "+919876543210" }, me)).toBe(true);
  });
  it("allows a legacy spot with no number", () => {
    expect(canClaim({ userId: null, phone: null }, me)).toBe(true);
  });
  it("refuses a spot saved for someone else's number", () => {
    expect(canClaim({ userId: null, phone: "+919000000001" }, me)).toBe(false);
  });
  it("refuses a spot someone already has", () => {
    expect(canClaim({ userId: "u9", phone: null }, me)).toBe(false);
    expect(canClaim({ userId: "u9", phone: "+919876543210" }, me)).toBe(false);
  });
});

describe("phone numbers", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+14155550123", "+14155550123"],
  ])("normalises %s", (raw, e164) => {
    expect(normalisePhone(raw)).toBe(e164);
  });
  it.each(["12345", "", "abc", "98765"])("rejects %s", (raw) => {
    expect(normalisePhone(raw)).toBeNull();
  });
  it("formats Indian numbers for display", () => {
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhone("+14155550123")).toBe("+14155550123");
  });
});
