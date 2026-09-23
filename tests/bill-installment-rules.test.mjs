import test from "node:test";
import assert from "node:assert/strict";
import { billInstallmentRequestFingerprint, buildBillInstallmentPlan, canonicalBillInstallmentRequest } from "../lib/bill-installment-rules.mjs";

const base = {
  description: "Móveis",
  totalAmountCents: 500000,
  installmentCount: 3,
  firstDueDate: "2026-10-23",
  categoryId: "category",
  subcategoryId: null,
  accountId: null,
  notes: null,
};

const amounts = (input) => buildBillInstallmentPlan({ ...base, ...input }).map((item) => item.amountCents);
const dates = (input) => buildBillInstallmentPlan({ ...base, ...input }).map((item) => item.dueDate);

test("R$ 5.000 / 3 preserva soma e distribui o resíduo nas últimas parcelas", () => {
  const plan = buildBillInstallmentPlan(base);
  assert.deepEqual(plan.map((item) => item.amountCents), [166666, 166667, 166667]);
  assert.deepEqual(plan.map((item) => item.installmentNumber), [1, 2, 3]);
  assert.ok(plan.every((item) => item.installmentCount === 3));
  assert.equal(plan.reduce((sum, item) => sum + item.amountCents, 0), 500000);
});

test("R$ 100 / 3 usa 3333, 3333 e 3334", () => {
  assert.deepEqual(amounts({ totalAmountCents: 10000 }), [3333, 3333, 3334]);
});

test("rejeita R$ 0,01 / 2 e aceita total igual à quantidade de centavos", () => {
  assert.throws(() => amounts({ totalAmountCents: 1, installmentCount: 2 }), /insuficiente/u);
  assert.deepEqual(amounts({ totalAmountCents: 2, installmentCount: 2 }), [1, 1]);
});

test("aceita os limites de 2 e 120 parcelas com soma exata", () => {
  assert.deepEqual(amounts({ totalAmountCents: 101, installmentCount: 2 }), [50, 51]);
  const plan = buildBillInstallmentPlan({ ...base, totalAmountCents: 120, installmentCount: 120 });
  assert.equal(plan.length, 120);
  assert.equal(plan.reduce((sum, item) => sum + item.amountCents, 0), 120);
});

test("rejeita quantidade, total e data civil inválidos", () => {
  for (const installmentCount of [1, 121, 2.5, NaN]) assert.throws(() => buildBillInstallmentPlan({ ...base, installmentCount }), /Quantidade/u);
  for (const totalAmountCents of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => buildBillInstallmentPlan({ ...base, totalAmountCents }), /Valor total/u);
  for (const firstDueDate of ["2027-02-29", "2026-02-31", "0000-01-01", "23/10/2026"]) assert.throws(() => buildBillInstallmentPlan({ ...base, firstDueDate }), /vencimento/u);
});

test("dias 28, 29, 30 e 31 preservam o dia configurado", () => {
  assert.deepEqual(dates({ firstDueDate: "2027-01-28", installmentCount: 3 }), ["2027-01-28", "2027-02-28", "2027-03-28"]);
  assert.deepEqual(dates({ firstDueDate: "2027-01-29", installmentCount: 3 }), ["2027-01-29", "2027-02-28", "2027-03-29"]);
  assert.deepEqual(dates({ firstDueDate: "2027-01-30", installmentCount: 3 }), ["2027-01-30", "2027-02-28", "2027-03-30"]);
  assert.deepEqual(dates({ firstDueDate: "2027-01-31", installmentCount: 5 }), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
});

test("fevereiro bissexto e virada de ano são civis e determinísticos", () => {
  assert.deepEqual(dates({ firstDueDate: "2028-01-31", installmentCount: 3 }), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  assert.deepEqual(dates({ firstDueDate: "2026-11-15", installmentCount: 4 }), ["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  assert.deepEqual(buildBillInstallmentPlan(base), buildBillInstallmentPlan({ ...base }));
});

test("serialização e fingerprint são canônicos e ignoram campos derivados", async () => {
  const normalized = { ...base, description: "  Móveis  ", seriesId: "ignored", createdAt: "ignored" };
  assert.equal(canonicalBillInstallmentRequest(normalized), canonicalBillInstallmentRequest(base));
  assert.equal(await billInstallmentRequestFingerprint(normalized), await billInstallmentRequestFingerprint(base));
  assert.notEqual(await billInstallmentRequestFingerprint({ ...base, notes: "outra" }), await billInstallmentRequestFingerprint(base));
});
