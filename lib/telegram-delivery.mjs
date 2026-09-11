export async function hasTelegramDeliveryFailure(deliveries) {
  const results = await Promise.allSettled(deliveries);
  return results.some((delivery) => delivery.status === "rejected");
}
