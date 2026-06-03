// Xendit test-mode "simulate paid" — fires the simulate endpoint against Xendit
// which then triggers a real webhook back to the dev Convex .site URL. The
// webhook signature is verified by convex/payments/webhook.ts using
// XENDIT_CALLBACK_TOKEN; that env must be set on both Xendit's dashboard and the
// Convex deployment.
//
// Source-cited endpoint shapes are in docs/xendit-reference/. If Xendit
// changes the simulate paths (they do, occasionally), update there + here.

const XENDIT_BASE = "https://api.xendit.co";

function basicAuth(): string {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY not set — required for e2e simulate");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

export async function simulateQrisPaid(qrId: string, amount: number): Promise<void> {
  const res = await fetch(`${XENDIT_BASE}/qr_codes/${qrId}/payments/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": basicAuth() },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    throw new Error(`simulateQrisPaid failed: ${res.status} ${await res.text()}`);
  }
}

export async function simulateBcaVaPaid(externalId: string, amount: number): Promise<void> {
  const url = `${XENDIT_BASE}/callback_virtual_accounts/external_id=${encodeURIComponent(externalId)}/simulate_payment`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": basicAuth() },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    throw new Error(`simulateBcaVaPaid failed: ${res.status} ${await res.text()}`);
  }
}
