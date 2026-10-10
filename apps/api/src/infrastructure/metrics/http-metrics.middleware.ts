import type { NextFunction, Request, Response } from 'express';
import { metrics } from './metrics';

/**
 * Records request count and latency labelled by the matched ROUTE TEMPLATE (e.g.
 * `/api/v1/public/emergency/:token`), never the concrete URL — tokens, Helmet IDs and query
 * strings must not become metric labels. Unmatched paths share one label.
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const route = (req.route as { path?: string } | undefined)?.path;
    const labels = {
      route: typeof route === 'string' ? route : 'unmatched',
      method: req.method,
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    metrics.httpRequests.inc({ ...labels, status: `${Math.floor(res.statusCode / 100)}xx` });
    metrics.httpDuration.observe(labels, seconds);
  });
  next();
}
