'use strict';

/**
 * services/sse.js
 * Server-Sent Events registry and broadcaster.
 * Tracks connected clients and broadcasts events to all or specific users.
 */

// Map<userId_string, Set<res>>
const _clients = new Map();

/**
 * Register an SSE response object for a user.
 * @param {string} userId
 * @param {import('http').ServerResponse} res
 */
function addClient(userId, res) {
  const uid = String(userId);
  if (!_clients.has(uid)) _clients.set(uid, new Set());
  _clients.get(uid).add(res);
}

/**
 * Remove an SSE response object (called on disconnect).
 * @param {string} userId
 * @param {import('http').ServerResponse} res
 */
function removeClient(userId, res) {
  const uid = String(userId);
  const set = _clients.get(uid);
  if (set) {
    set.delete(res);
    if (set.size === 0) _clients.delete(uid);
  }
}

/**
 * Send a named SSE event to a single response object.
 * @param {import('http').ServerResponse} res
 * @param {string} event
 * @param {object} data
 */
function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* client disconnected */ }
}

/**
 * Broadcast an event to ALL connected clients.
 * @param {string} event
 * @param {object} data
 */
function broadcast(event, data) {
  for (const [, set] of _clients) {
    for (const res of set) {
      sendEvent(res, event, data);
    }
  }
}

/**
 * Send an event to a specific user (all their connections).
 * @param {string|bigint} userId
 * @param {string} event
 * @param {object} data
 */
function sendToUser(userId, event, data) {
  const set = _clients.get(String(userId));
  if (!set) return;
  for (const res of set) {
    sendEvent(res, event, data);
  }
}

/**
 * Returns the number of currently connected clients.
 */
function clientCount() {
  let n = 0;
  for (const [, set] of _clients) n += set.size;
  return n;
}

module.exports = { addClient, removeClient, sendEvent, broadcast, sendToUser, clientCount };
