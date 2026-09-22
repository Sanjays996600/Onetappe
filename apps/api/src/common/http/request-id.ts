import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

/**
 * Every request gets an id (the client's X-Request-Id when well-formed, else a new one).
 * It is returned in the response header, written to every audit/history row and logs.
 */
export function registerRequestId(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request: FastifyRequest & { requestId?: string }, reply, done) => {
    const incoming = request.headers['x-request-id'];
    request.requestId =
      typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    void reply.header('x-request-id', request.requestId);
    done();
  });
}
