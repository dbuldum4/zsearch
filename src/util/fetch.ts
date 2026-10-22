/** Fetch raw bytes only. Bun 1.4.4 patches the Brotli decoder (CVE-2026-111497); refusing compressed bodies keeps model downloads safe on older runtimes too. */
export async function fetchIdentity(input: string | URL, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set("Accept-Encoding", "identity")
  // The server can ignore Accept-Encoding. Disable decoding in the runtime before
  // it receives any response bytes, including during redirects, then check headers.
  const request = { ...init, headers, decompress: false }
  const response = await fetchImpl(input, request)
  const encodings = response.headers.get("Content-Encoding")?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? []
  if (encodings.some((value) => value !== "identity")) {
    await response.body?.cancel()
    throw new Error(`download refused compressed response (${encodings.join(", ")}); the server must send identity encoding`)
  }
  return response
}
