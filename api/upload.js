'use strict';

const crypto = require('crypto');
const http = require('./_http');
const store = require('./_store');

/**
 * Attachment intake.
 *
 * With Vercel Blob configured the file is stored there and the worker streams
 * it by URL at send time, so a large brochure is uploaded once rather than once
 * per recipient. Without Blob we fall back to holding the bytes in the campaign
 * record, which is why the fallback ceiling is much lower.
 */

// Vercel caps a serverless request body at 4.5 MB; base64 inflates by ~33%.
const MAX_FILE_BYTES = 3.2 * 1024 * 1024;
const MAX_FILE_BYTES_NO_BLOB = 1.5 * 1024 * 1024;

const ALLOWED = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip'
]);

const EXT_FALLBACK = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip'
};

function safeName(name) {
  return String(name || 'attachment')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'attachment';
}

module.exports = http.protect(async (req, res) => {
  const body = await http.readJson(req, 5 * 1024 * 1024);

  if (body.action === 'delete') {
    if (body.url && process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const { del } = require('@vercel/blob');
        await del(body.url);
      } catch (err) {
        console.error('[upload] blob delete failed:', err.message);
      }
    }
    return http.json(res, 200, { ok: true });
  }

  const name = safeName(body.name);
  const ext = name.split('.').pop().toLowerCase();
  const declaredType = body.type && ALLOWED.has(body.type) ? body.type : EXT_FALLBACK[ext];

  if (!declaredType) {
    return http.json(res, 415, { error: 'Unsupported file type. Allowed: PDF, Word, Excel, PowerPoint, images, text, CSV, ZIP.' });
  }

  if (typeof body.data !== 'string' || !body.data) {
    return http.json(res, 400, { error: 'No file content received' });
  }

  let buffer;
  try {
    buffer = Buffer.from(body.data, 'base64');
  } catch (_) {
    return http.json(res, 400, { error: 'File content was not valid base64' });
  }

  const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const ceiling = hasBlob ? MAX_FILE_BYTES : MAX_FILE_BYTES_NO_BLOB;
  if (buffer.length > ceiling) {
    return http.json(res, 413, {
      error: 'File is ' + (buffer.length / 1048576).toFixed(1) + ' MB. The limit is '
        + (ceiling / 1048576).toFixed(1) + ' MB'
        + (hasBlob ? '.' : ' without Vercel Blob configured. Add BLOB_READ_WRITE_TOKEN to raise it.')
    });
  }

  if (hasBlob) {
    const { put } = require('@vercel/blob');
    const key = 'kech/attachments/' + crypto.randomBytes(6).toString('hex') + '-' + name;
    const blob = await put(key, buffer, {
      access: 'public',
      contentType: declaredType,
      addRandomSuffix: false,
      allowOverwrite: true
    });
    return http.json(res, 200, {
      attachment: { name, size: buffer.length, type: declaredType, url: blob.url },
      storage: 'blob'
    });
  }

  // Fallback: keep the bytes in the store, keyed so the campaign can reference them.
  const id = 'att_' + crypto.randomBytes(8).toString('hex');
  await store.set('attachments/' + id, { name, type: declaredType, data: buffer.toString('base64') });
  return http.json(res, 200, {
    attachment: { name, size: buffer.length, type: declaredType, ref: id, data: buffer.toString('base64') },
    storage: 'inline',
    warning: 'No blob storage configured - the file is carried inside the campaign record.'
  });
});
