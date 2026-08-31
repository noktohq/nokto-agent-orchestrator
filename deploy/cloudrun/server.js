// Public project endpoint for nokto-agent-orchestrator.
// Zero-dependency HTTP server intended for Google Cloud Run:
//   gcloud run deploy nokto-agent --source deploy/cloudrun --region europe-north1 --allow-unauthenticated
const http = require('http');

const PORT = Number(process.env.PORT) || 8080;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nokto-agent-orchestrator</title>
<style>
  body{margin:0;background:#0c0e12;color:#e8ecf2;font-family:system-ui,sans-serif;line-height:1.6}
  main{max-width:720px;margin:0 auto;padding:64px 24px}
  h1{font-family:ui-monospace,monospace;font-size:1.9rem;margin:0 0 8px}
  h1::before{content:"$ ";color:#5f6875}
  p{color:#96a0ae;max-width:60ch}
  .pill{display:inline-block;font-family:ui-monospace,monospace;font-size:12px;border:1px solid rgba(106,165,255,.35);color:#6aa5ff;border-radius:999px;padding:3px 12px;margin:0 8px 8px 0}
  a{color:#6aa5ff}
  ol{color:#96a0ae}
  footer{margin-top:48px;color:#5f6875;font-size:13px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px}
</style>
</head>
<body>
<main>
  <h1>nokto-agent-orchestrator</h1>
  <p>Orchestrates Claude Code, OpenAI Codex and Google Gemini in a controlled delivery workflow
  for code changes submitted through pull requests. Each task contract is planned, validated,
  implemented in an isolated Git worktree, cross-reviewed by a second frontier model, and verified
  against the task's own test commands. Changes are never merged automatically.</p>
  <div>
    <span class="pill">task contracts</span><span class="pill">worktree isolation</span><span class="pill">cross-model review</span><span class="pill">fail closed</span><span class="pill">Gemini via Google GenAI SDK</span>
  </div>
  <ol>
    <li>Source and reproducible testing instructions: <a href="https://github.com/noktohq/nokto-agent-orchestrator">github.com/noktohq/nokto-agent-orchestrator</a></li>
    <li>Health check: <a href="/healthz">/healthz</a></li>
  </ol>
  <footer>Built and used in production by Nokto · Public endpoint served from Google Cloud Run · All Things Agentic Hackathon</footer>
</main>
</body>
</html>
`;

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  })
  .listen(PORT, () => {
    console.log(`nokto-agent-orchestrator web endpoint listening on :${PORT}`);
  });
