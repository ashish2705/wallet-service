import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const publicPaths = new Set(["/healthz", "/metrics", "/admin/seed"]);

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = readBearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "missing_bearer_token" });
    return;
  }

  request.userId = token;
}

export function installAuthHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (publicPaths.has(request.url)) {
      return;
    }

    await requireUser(request, reply);
  });
}
