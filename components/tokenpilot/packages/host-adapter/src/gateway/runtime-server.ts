import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  closeHttpServer,
  listenHttpServer,
  readHttpRequestBody,
  sendJsonResponse,
} from "./http-server.js";

export type HostGatewayRuntimeServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export async function startHostGatewayRuntimeServer(params: {
  port: number;
  requestPath: string;
  basePath?: string;
  healthPayload: unknown;
  handleRoute?(args: {
    req: IncomingMessage;
    res: ServerResponse;
    pathname: string;
    readBody(): Promise<string>;
  }): Promise<boolean | void>;
  handleRequest(args: {
    req: IncomingMessage;
    res: ServerResponse;
    pathname: string;
    body: string;
  }): Promise<void>;
  handleError?(args: {
    error: unknown;
    req: IncomingMessage;
    res: ServerResponse;
  }): Promise<void>;
}): Promise<HostGatewayRuntimeServer> {
  const basePath = params.basePath ?? "/v1";
  const server = createServer(async (req, res) => {
    try {
      let bodyPromise: Promise<string> | null = null;
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const readBody = () => {
        bodyPromise ??= readHttpRequestBody(req);
        return bodyPromise;
      };
      if (req.method === "GET" && pathname === "/health") {
        sendJsonResponse(res, 200, params.healthPayload);
        return;
      }
      if (params.handleRoute) {
        const handled = await params.handleRoute({
          req,
          res,
          pathname,
          readBody,
        });
        if (handled) return;
      }
      if (req.method !== "POST" || pathname !== params.requestPath) {
        sendJsonResponse(res, 404, { error: "not found" });
        return;
      }
      const body = await readBody();
      await params.handleRequest({
        req,
        res,
        pathname,
        body,
      });
    } catch (error) {
      if (params.handleError) {
        await params.handleError({ error, req, res });
        return;
      }
      sendJsonResponse(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await listenHttpServer(server, params.port);

  return {
    baseUrl: `http://127.0.0.1:${params.port}${basePath}`,
    close() {
      return closeHttpServer(server);
    },
  };
}
