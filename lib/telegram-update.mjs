import { z } from "zod";

const telegramId = z.union([
  z.number().int().safe(),
  z.string().regex(/^-?\d{1,20}$/u),
]).transform(String);

const telegramUpdateEnvelopeSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
}).passthrough();

const messageSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  chat: z.object({
    id: telegramId,
    type: z.string().max(30).optional(),
  }).passthrough(),
  from: z.object({ id: telegramId }).passthrough(),
}).passthrough();

const callbackSchema = z.object({
  id: z.string().min(1).max(200),
  data: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/u),
  from: z.object({ id: telegramId }).passthrough(),
  message: z.object({
    chat: z.object({
      id: telegramId,
      type: z.string().max(30).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export const telegramUpdateSchema = telegramUpdateEnvelopeSchema.extend({
  message: messageSchema.optional(),
  callback_query: callbackSchema.optional(),
}).refine((value) => Boolean(value.message || value.callback_query), "Update sem mensagem suportada.");

export function classifyTelegramUpdate(rawUpdate) {
  const envelope = telegramUpdateEnvelopeSchema.safeParse(rawUpdate);
  if (!envelope.success) return { kind: "invalid" };

  const processable = telegramUpdateSchema.safeParse(rawUpdate);
  if (!processable.success) return { kind: "unsupported" };

  return { kind: "processable", update: processable.data };
}
