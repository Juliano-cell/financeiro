import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, dateForDayOfMonth, invoiceSchedule } from "../lib/finance-rules.mjs";

const dates = (startMonth, dayOfMonth, count) => Array.from({ length: count }, (_, index) => dateForDayOfMonth(addMonths(startMonth, index), dayOfMonth));

test("dia 31 usa o último dia válido sem contaminar o mês seguinte", () => {
  assert.deepEqual(dates("2027-01", 31, 5), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  assert.deepEqual(dates("2028-01", 31, 3), ["2028-01-31", "2028-02-29", "2028-03-31"]);
});

test("dia 30 retorna ao dia nominal depois de fevereiro", () => {
  assert.deepEqual(dates("2027-02", 30, 3), ["2027-02-28", "2027-03-30", "2027-04-30"]);
  assert.deepEqual(dates("2028-02", 30, 3), ["2028-02-29", "2028-03-30", "2028-04-30"]);
});

test("dia 29 distingue fevereiro comum e bissexto", () => {
  assert.deepEqual(dates("2027-02", 29, 2), ["2027-02-28", "2027-03-29"]);
  assert.deepEqual(dates("2028-02", 29, 2), ["2028-02-29", "2028-03-29"]);
});

test("dias 1 e 28 permanecem estáveis", () => {
  assert.equal(dateForDayOfMonth("2027-02", 1), "2027-02-01");
  assert.equal(dateForDayOfMonth("2027-02", 28), "2027-02-28");
});

test("dia recorrente aceita somente inteiros de 1 a 31", () => {
  for (const value of [0, 32, 99, -1, 1.5, NaN]) assert.throws(() => dateForDayOfMonth("2027-01", value), /Dia do mês inválido/u);
  assert.throws(() => dateForDayOfMonth("2027-13", 31), /Mês inválido/u);
});

test("dezembro para janeiro preserva o dia nominal", () => {
  assert.deepEqual(dates("2027-12", 31, 3), ["2027-12-31", "2028-01-31", "2028-02-29"]);
});

test("agenda de cartão reutiliza a regra canônica em meses consecutivos", () => {
  const schedule = invoiceSchedule("2027-01-02", 5, 31, 5);
  assert.deepEqual(schedule.map((item) => item.dueDate), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
});

test("data específica inválida continua inválida no domínio", () => {
  assert.notEqual(dateForDayOfMonth("2027-02", 31), "2027-02-31");
  assert.equal(dateForDayOfMonth("2027-02", 31), "2027-02-28");
});
