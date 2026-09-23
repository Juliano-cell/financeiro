import test from "node:test";
import assert from "node:assert/strict";
import { billPaymentAdjustment, formatBillPaymentInput, parseBillPaymentCents } from "../lib/bill-payment.mjs";

test("parser monetário brasileiro converte valores sem usar regra de float", () => {
  assert.equal(parseBillPaymentCents("100"), 10_000);
  assert.equal(parseBillPaymentCents("100,00"), 10_000);
  assert.equal(parseBillPaymentCents("100,01"), 10_001);
  assert.equal(parseBillPaymentCents("99,99"), 9_999);
  assert.equal(parseBillPaymentCents("1.234,56"), 123_456);
  assert.equal(formatBillPaymentInput(10_001), "100,01");
});

test("parser rejeita vazio, zero, negativo, NaN, ponto decimal, excesso de casas e limite", () => {
  for (const value of ["", "0", "0,00", "-1", "NaN", "100.01", "100,001", "1.23,45", "1000000000,01"]) {
    assert.throws(() => parseBillPaymentCents(value));
  }
});

test("ajuste é derivado exatamente como normal, acréscimo ou desconto", () => {
  assert.deepEqual(billPaymentAdjustment(10_000, 10_000), { adjustmentAmountCents: 0, adjustmentType: "normal" });
  assert.deepEqual(billPaymentAdjustment(10_000, 10_500), { adjustmentAmountCents: 500, adjustmentType: "surcharge" });
  assert.deepEqual(billPaymentAdjustment(10_000, 9_500), { adjustmentAmountCents: -500, adjustmentType: "discount" });
  assert.deepEqual(billPaymentAdjustment(10_000, 10_001), { adjustmentAmountCents: 1, adjustmentType: "surcharge" });
  assert.deepEqual(billPaymentAdjustment(10_000, 9_999), { adjustmentAmountCents: -1, adjustmentType: "discount" });
});
