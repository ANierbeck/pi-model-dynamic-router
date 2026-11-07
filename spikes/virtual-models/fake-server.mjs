// OpenAI-compatible fake provider for the virtual-model spike
// (docs/research/2026-11-06-virtual-model-spike.md); see README.md.
// The mode is the last character of the model id — the branches below name
// each one. Every request is appended to $SPIKE_OUT/requests.jsonl.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.SPIKE_PORT ?? 8791);
const LOG = `${process.env.SPIKE_OUT ?? '/tmp/vm-spike'}/requests.jsonl`;
const T0 = Date.now();
mkdirSync(LOG.slice(0, LOG.lastIndexOf('/')), { recursive: true });

function log(row) {
  appendFileSync(LOG, JSON.stringify({ t: Date.now() - T0, ...row }) + '\n');
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) res.write(c);
  res.end();
}

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let model = '?';
    try {
      model = JSON.parse(body).model ?? '?';
    } catch {
      /* ignore */
    }
    log({ model, path: req.url });
    const mode = model.slice(-1);

    if (mode === 'a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }));
      return;
    }
    if (mode === 'b') {
      // 200, well-formed SSE, no content at all.
      sse(res, ['data: [DONE]\n\n']);
      return;
    }
    if (mode === 'e') {
      // 429 whose body says the limit resets in hours (claude-bridge shape).
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Claude quota exceeded - rate limit (five_hour) - resets 3:00 PM: You've hit your session limit",
            type: 'rate_limit_error',
          },
        })
      );
      return;
    }
    if (mode === 'f') {
      // 429 whose body matches Pi's NON_RETRYABLE pattern ("quota exceeded").
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exceeded for this month', type: 'x' } }));
      return;
    }
    if (mode === 'g') {
      // Well-formed stream, finish_reason stop, but no content at all: the
      // claude-bridge "empty response (no content, no error reported)" shape.
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      sse(res, [chunk({ role: 'assistant' }, null), chunk({}, 'stop'), 'data: [DONE]\n\n']);
      return;
    }
    if (mode === 'h') {
      // 429 that cannot clear within Pi's 14 s retry budget, but without any of
      // Pi's NON_RETRYABLE magic words.
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: "You've hit your session limit. It resets in 3 hours.",
            type: 'rate_limit_error',
          },
        })
      );
      return;
    }
    if (mode === 'j') {
      // OpenRouter-style context overflow: Pi should compact and retry.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 2000 tokens. However, your messages resulted in 8000 tokens.",
            code: 'context_length_exceeded',
            type: 'invalid_request_error',
          },
        })
      );
      return;
    }
    if (mode === 'd') {
      // Accept, send headers, never finish: a stall.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      return;
    }
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({
        id: 'x',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    sse(res, [
      chunk({ role: 'assistant', content: 'ok' }, null),
      chunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake provider on ${PORT}`));
