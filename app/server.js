const http = require("http");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const body = JSON.stringify({
      status: "ok",
      service: "skedly-scheduler"
    });

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
    return;
  }

  const body = JSON.stringify({ error: "not_found" });

  res.writeHead(404, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`[skedly-scheduler] listening on http://${HOST}:${PORT}`);
});
