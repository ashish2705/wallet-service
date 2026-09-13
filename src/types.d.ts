import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: bigint;
    userId?: string;
  }
}
