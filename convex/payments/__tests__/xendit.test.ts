import { describe, it, expect, beforeEach } from "vitest";
import {
  buildQrisBody,
  buildQrisHeaders,
  buildBcaVaBody,
  parseXenditWebhook,
} from "../xendit";

beforeEach(() => {
  process.env.XENDIT_SECRET_KEY = "xnd_test_fake";
});

describe("buildQrisHeaders", () => {
  it("pins api-version 2022-07-31 (regression guard — dropping it silently kills the webhook)", () => {
    const h = buildQrisHeaders("idem-1");
    expect(h["api-version"]).toBe("2022-07-31");
    expect(h["X-IDEMPOTENCY-KEY"]).toBe("idem-1");
    expect(h.Authorization).toMatch(/^Basic /);
  });
});

describe("buildQrisBody", () => {
  it("builds a DYNAMIC IDR QR body echoing ref as reference_id + external_id", () => {
    expect(buildQrisBody("pos-abc", 35000)).toEqual({
      reference_id: "pos-abc",
      external_id: "pos-abc",
      type: "DYNAMIC",
      currency: "IDR",
      amount: 35000,
    });
  });
});

describe("buildBcaVaBody", () => {
  it("builds a closed single-use exact-amount BCA VA body", () => {
    expect(buildBcaVaBody("pos-xyz", 50000)).toEqual({
      external_id: "pos-xyz",
      bank_code: "BCA",
      name: "Frollie POS",
      expected_amount: 50000,
      is_closed: true,
      is_single_use: true,
    });
  });
});

describe("parseXenditWebhook", () => {
  it("QRIS SUCCEEDED envelope → paid, matchKey=qr_id, amount + reconciliation fields", () => {
    const body = JSON.stringify({
      event: "qr.payment",
      data: {
        id: "qr_inner",
        qr_id: "qr_123",
        status: "SUCCEEDED",
        amount: 35000,
        payment_detail: { receipt_id: "RRN-1", source: "DANA" },
      },
    });
    expect(parseXenditWebhook(body)).toEqual({
      paid: true,
      matchKey: "qr_123",
      amount: 35000,
      receiptId: "RRN-1",
      source: "DANA",
    });
  });

  it("QRIS non-SUCCEEDED status → not paid", () => {
    const body = JSON.stringify({ event: "qr.payment", data: { qr_id: "qr_9", status: "PENDING" } });
    expect(parseXenditWebhook(body)).toEqual({ paid: false, matchKey: null });
  });

  it("BCA flat FVA callback → paid, matchKey=callback_virtual_account_id (live-unverified shape)", () => {
    const body = JSON.stringify({
      callback_virtual_account_id: "va_456",
      external_id: "pos-xyz",
      account_number: "1080012345",
      amount: 50000,
      payment_id: "pay_1",
    });
    expect(parseXenditWebhook(body)).toEqual({
      paid: true,
      matchKey: "va_456",
      amount: 50000,
      receiptId: "pay_1",
    });
  });

  it("legacy flat Invoice shape {id,status:PAID} is now ignored", () => {
    expect(parseXenditWebhook(JSON.stringify({ id: "inv_1", status: "PAID" }))).toEqual({
      paid: false,
      matchKey: null,
    });
  });

  it("unparseable / empty → not paid, no match key", () => {
    expect(parseXenditWebhook("not json")).toEqual({ paid: false, matchKey: null });
    expect(parseXenditWebhook("")).toEqual({ paid: false, matchKey: null });
  });
});
