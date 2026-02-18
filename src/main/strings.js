'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const SUPPORTED_LOCALES = ['ko', 'en', 'ja', 'es'];
const DEFAULT_LOCALE = 'en';

let strings = {};
let currentLocale = DEFAULT_LOCALE;

/**
 * Detect system language and load the corresponding locale file.
 * Must be called after app.isReady().
 */
function init(localeOverride) {
  let lang;
  if (localeOverride && SUPPORTED_LOCALES.includes(localeOverride)) {
    lang = localeOverride;
  } else {
    const systemLocale = app.getLocale(); // e.g. "ko", "ko-KR", "en-US"
    lang = systemLocale.split('-')[0].toLowerCase();
  }

  currentLocale = SUPPORTED_LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;

  const localePath = path.join(__dirname, '..', 'locales', `${currentLocale}.json`);
  const fallbackPath = path.join(__dirname, '..', 'locales', `${DEFAULT_LOCALE}.json`);

  try {
    strings = JSON.parse(fs.readFileSync(localePath, 'utf-8'));
  } catch {
    strings = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    currentLocale = DEFAULT_LOCALE;
  }
}

/**
 * Return the translated string for the given key.
 * Supports variable substitution: t('key', { name: 'value' }) replaces "{name}" with "value".
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
function t(key, vars) {
  let str = strings[key];
  if (str === undefined) return key; // return key itself as fallback

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return str;
}

/**
 * Return the full strings object (for Renderer process via IPC).
 * @returns {{ locale: string, strings: Record<string, string> }}
 */
function getAll() {
  return { locale: currentLocale, strings };
}

module.exports = { init, t, getAll };
