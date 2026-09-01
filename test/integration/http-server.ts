import { createServer, type Server } from "node:http";

export interface TestHttpServer {
  readonly baseUrl: string;
  getSlowRequestCount(): number;
  close(): Promise<void>;
}

export interface TestHttpServerOptions {
  readonly port?: number;
  readonly slowDelayMs?: number;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function delayWhileConnected(
  response: import("node:http").ServerResponse,
  delayMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = (connected: boolean): void => {
      clearTimeout(timer);
      response.off("close", onClose);
      resolve(connected);
    };
    const onClose = (): void => finish(false);

    timer = setTimeout(() => finish(true), delayMs);
    response.once("close", onClose);
  });
}

export async function startTestHttpServer(
  options: TestHttpServerOptions = {},
): Promise<TestHttpServer> {
  const slowDelayMs = options.slowDelayMs ?? 1_000;
  let slowRequestCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/body-echo") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString("utf8");
      sendJson(response, 200, { body: JSON.parse(content) });
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }

    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (url.pathname === "/failure") {
      sendJson(response, 200, { value: "actual" });
      return;
    }

    if (url.pathname === "/auth-echo") {
      sendJson(response, 200, {
        authorization: request.headers.authorization ?? null,
      });
      return;
    }

    if (url.pathname === "/slow") {
      slowRequestCount += 1;
      if (await delayWhileConnected(response, slowDelayMs)) {
        sendJson(response, 200, { status: "delayed" });
      }
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  await listen(server, options.port ?? 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Test HTTP server did not bind to a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getSlowRequestCount: () => slowRequestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
