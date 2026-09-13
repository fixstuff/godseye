import { defaultSourceRoot } from '../common/source-root.js';
import path from 'node:path';
import { readRequestBody } from '../common/request.js';
import fs from 'node:fs';

const REALTIME_DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Log size that triggers rotation; one previous generation is kept. */
const REALTIME_DEBUG_LOG_ROTATE_BYTES = 16 * 1024 * 1024;

/** Move a full log aside so the directory never holds more than two generations. */
function rotateWhenFull(file, previousFile, incomingBytes, rotateBytes) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (size > 0 && size + incomingBytes > rotateBytes) {
    fs.renameSync(file, previousFile);
  }
}

function createDebugLogHandler({
  sourceRoot = defaultSourceRoot,
  rotateBytes = REALTIME_DEBUG_LOG_ROTATE_BYTES,
} = {}) {
  const REALTIME_DEBUG_LOG_DIR = path.join(sourceRoot, '.gev-logs');
  const REALTIME_DEBUG_LOG_FILE = path.join(
    REALTIME_DEBUG_LOG_DIR,
    'realtime-conversations.jsonl',
  );
  const REALTIME_DEBUG_LOG_PREVIOUS_FILE = path.join(
    REALTIME_DEBUG_LOG_DIR,
    'realtime-conversations.1.jsonl',
  );
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      const body = await readRequestBody(req, REALTIME_DEBUG_LOG_MAX_BYTES);
      const record = JSON.parse(body || '{}');
      const line = `${JSON.stringify({
        loggedAt: new Date().toISOString(),
        ...record,
      })}\n`;
      fs.mkdirSync(REALTIME_DEBUG_LOG_DIR, { recursive: true });
      rotateWhenFull(
        REALTIME_DEBUG_LOG_FILE,
        REALTIME_DEBUG_LOG_PREVIOUS_FILE,
        Buffer.byteLength(line),
        rotateBytes,
      );
      fs.appendFileSync(REALTIME_DEBUG_LOG_FILE, line);
      res.statusCode = 204;
      res.end();
    } catch (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: error?.message || 'Failed to write Realtime debug log',
        }),
      );
    }
  };
}

export { createDebugLogHandler };
