'use strict';

function sanitizeDefaults(value, validServerUrl) {
  return { serverUrl: validServerUrl(value?.serverUrl) || '' };
}

function sanitizeResume(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.at) || value.at < 0 || value.at > now + 60 * 1000 || now - value.at >= 10 * 60 * 1000) return null;
  return { at: value.at, hidden: value.hidden === true, autoLaunch: value.autoLaunch === true };
}

module.exports = { sanitizeDefaults, sanitizeResume };
