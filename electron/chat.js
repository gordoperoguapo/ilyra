// State shared by chat requests in the main process: which request is running
// (so it can be stopped, and only one runs at a time), and the short-lived,
// per-chat approval for file edits.
const inFlight = new Map();   // sender id -> { requestId, controller }
const approvals = new Map();  // chat id -> { left, until }

const APPROVAL_EDITS = 10;
const APPROVAL_MS = 30 * 60 * 1000;

function begin(senderId, requestId) {
  if (inFlight.has(senderId)) return null;
  const controller = new AbortController();
  inFlight.set(senderId, { requestId, controller });
  return controller;
}

function end(senderId, requestId) {
  const f = inFlight.get(senderId);
  if (f && f.requestId === requestId) inFlight.delete(senderId);
}

function cancel(senderId, requestId) {
  const f = inFlight.get(senderId);
  if (!f || f.requestId !== requestId) return false;
  f.controller.abort();
  return true;
}

// "Allow edits in this chat": up to 10 edits or 30 minutes, then the dialog returns.
function status(chatId, now = Date.now()) {
  const a = chatId && approvals.get(chatId);
  if (!a) return null;
  if (a.left <= 0 || now >= a.until) { approvals.delete(chatId); return null; }
  return { left: a.left, until: a.until };
}

function grant(chatId, now = Date.now()) {
  if (!chatId) return null;
  approvals.set(chatId, { left: APPROVAL_EDITS, until: now + APPROVAL_MS });
  return status(chatId, now);
}

function revoke(chatId) {
  approvals.delete(chatId);
  return null;
}

// Uses up one auto-approved edit. Returns the new status, or false when there is none.
function consume(chatId, now = Date.now()) {
  if (!status(chatId, now)) return false;
  approvals.get(chatId).left -= 1;
  return status(chatId, now) || { left: 0, until: now };
}

// Reading the clipboard is allowed per chat, after one yes.
const clipboardChats = new Set();
const clipboardAllowed = (chatId) => Boolean(chatId) && clipboardChats.has(chatId);
const allowClipboard = (chatId) => { if (chatId) clipboardChats.add(chatId); };

module.exports = { clipboardAllowed, allowClipboard, begin, end, cancel, status, grant, revoke, consume, APPROVAL_EDITS, APPROVAL_MS };
