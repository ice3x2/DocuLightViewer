'use strict';

const { publishSave } = require('../../../src/main/index-ingress-store');

process.on('message', async message => {
  if (message?.type !== 'publish') return;
  process.send({ type: 'attempting' });
  try {
    const saved = await publishSave({ ...message.input,
      contentBytes: Buffer.from(message.bodyBase64, 'base64') });
    process.send({ type: 'published', saved });
  } catch (error) {
    process.send({ type: 'failed', code: error.code || 'unknown' });
  }
});
process.send({ type: 'ready' });
