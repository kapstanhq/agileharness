// VAPID public key endpoint — the client fetches the server's public key at RUNTIME
// (not baked into the bundle) so the VPS can rotate keys without a rebuild. Returns
// { publicKey: null } when push isn't configured, which the client treats as "off".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ publicKey: process.env.STORYMAP_VAPID_PUBLIC_KEY ?? null });
}
