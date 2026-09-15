import { getEndpointMetadataFromClass, getLambdaMetadataFromClass } from '@microgamma/apigator';
import { getDebugger } from '@microphi/debug';
import express, { Express, NextFunction, Request, Response } from 'express';

import { ApiConfig } from '../config';

const d = getDebugger('watchers:api:routes');

type Handler = (req: Request, res: Response) => unknown;

export function createApp(config: ApiConfig, endpoints: object[]): Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(cors(config.corsOrigins));

  for (const endpoint of endpoints) {
    register(app, endpoint);
  }

  return app;
}

/**
 * Turns apigator's metadata into Express routes.
 *
 * The decorated method is called with `(req, res)` because that is the shape
 * `ExpressEventHandler` expects to destructure; the handler is what maps them
 * onto the method's declared `@Body`/`@Path` arguments.
 */
function register(app: Express, instance: object): void {
  const klass = instance.constructor;
  const { basePath = '' } = getEndpointMetadataFromClass(klass) ?? {};

  for (const lambda of getLambdaMetadataFromClass(klass) ?? []) {
    const path = toExpressPath(`${basePath}${lambda.path}`);
    const method = String(lambda.method).toLowerCase() as 'get' | 'post';
    const handler = (instance as Record<string, Handler>)[lambda.name];

    if (typeof handler !== 'function') {
      throw new Error(`${klass.name}.${lambda.name} is not callable`);
    }

    d('route', method.toUpperCase(), path);
    app[method](path, (req, res) => handler.call(instance, req, res));
  }
}

/** apigator declares AWS-style `/traces/{traceId}`; Express wants `:traceId`. */
export function toExpressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

/**
 * Deliberately not the `cors` package: the Angular app is the only browser
 * client, the API is read-only and uncredentialed, and an allow-list read from
 * config is the whole requirement.
 */
function cors(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allowed = origins.includes('*') ? '*' : origins.find((entry) => entry === origin);

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowed);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] ?? 'content-type',
      );
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
