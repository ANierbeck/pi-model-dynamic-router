// HTTP client for the sidecar contract (POST /classify, GET /health). Same shape the router uses.
export async function health(url) {
  const res = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url}/health -> ${res.status}`);
  return res.json();
}

export async function classify(url, item) {
  const res = await fetch(new URL('/classify', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: item.prompt, context: item.context }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`POST ${url}/classify -> ${res.status}: ${await res.text()}`);
  return res.json();
}
