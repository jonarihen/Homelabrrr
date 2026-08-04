import { errorPayload, resolveErrorStatus } from '../utils/httpError.js';
import { log } from '../utils/logger.js';

export function globalErrorHandler(err, req, res, next) {
  log('error', 'unhandled_error', { requestId: req.requestId, error: err });
  // Once a streaming handler has committed headers, Express's final handler is
  // responsible for terminating the socket. Writing a second JSON response
  // would throw ERR_HTTP_HEADERS_SENT and obscure the original failure.
  if (res.headersSent) return next(err);
  const status = resolveErrorStatus(err);
  return res.status(status).json({ ...errorPayload(err, status), requestId: req.requestId });
}
