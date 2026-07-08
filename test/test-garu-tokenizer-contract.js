'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createKeywordTokenizer,
  createBasicKeywordTokenizer
} = require('../src/main/search-tokenizer');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');

function createFakeGaru() {
  const calls = [];
  const lexicon = new Map([
    ['라이선스를', ['라이선스']],
    ['라이선스', ['라이선스']],
    ['사용할', ['사용']],
    ['사용', ['사용']],
    ['없습니다', ['없']],
    ['없', ['없']],
    ['전자문서', ['전자', '문서']],
    ['먹었다', ['먹']],
    ['먹다', ['먹']]
  ]);

  return {
    calls,
    analyze(text) {
      calls.push(text);
      const tokens = [];
      for (const word of String(text).split(/\s+/)) {
        const cleaned = word.replace(/[^\w가-힣]/g, '');
        const mapped = lexicon.get(cleaned) || [];
        for (const term of mapped) {
          tokens.push({ text: term, pos: 'NNG' });
        }
      }
      return { tokens, score: 1, elapsed: 0 };
    },
    modelInfo() {
      return { version: 'fake-garu', size: 1, accuracy: 1 };
    }
  };
}

function makeDocument(filePath, body) {
  return {
    filePath,
    meta: {
      title: path.basename(filePath, '.md'),
      snippet: body.slice(0, 120)
    },
    body,
    contentHash: 'hash',
    textHash: 'text-hash'
  };
}

(async () => {
  {
    const fake = createFakeGaru();
    const tokenizer = createKeywordTokenizer({
      provider: 'garu',
      maxAnalysisChars: 64,
      loadGaru: async () => fake
    });

    await tokenizer.initialize();
    const tokens = tokenizer.tokenize('라이선스를 사용할 수 없습니다');

    assert(tokens.includes('라이선스를'), 'existing tokenizer surface token is preserved');
    assert(tokens.includes('라이선스'), 'garu content token strips Korean object particle');
    assert(tokens.includes('사용'), 'garu content token strips Korean verb ending');
    assert(tokens.includes('없'), 'garu content token keeps adjective stem');
    assert.strictEqual(tokenizer.getStatus().provider, 'garu-ko');
    assert.strictEqual(tokenizer.getStatus().available, true);
  }

  {
    const tokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => {
        throw new Error('forced garu load failure');
      }
    });

    await tokenizer.initialize();
    const tokens = tokenizer.tokenize('라이선스를 사용할 수 없습니다');

    assert(tokens.includes('라이선스를'), 'fallback keeps existing tokenizer output after garu load failure');
    assert.strictEqual(tokenizer.getStatus().provider, 'basic');
    assert.strictEqual(tokenizer.getStatus().available, false);
    assert(tokenizer.getStatus().degradedReason.includes('forced garu load failure'));
  }

  {
    const tokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => ({
        analyze() {
          throw new Error('forced garu analyze failure');
        },
        modelInfo() {
          return { version: 'fake-garu', size: 1, accuracy: 1 };
        }
      })
    });

    await tokenizer.initialize();
    const tokens = tokenizer.tokenize('라이선스를 사용할 수 없습니다');
    const status = tokenizer.getStatus();
    const meta = tokenizer.getIndexMetadata();

    assert(tokens.includes('라이선스를'), 'fallback keeps existing tokenizer output after garu analyze failure');
    assert.strictEqual(status.provider, 'garu-ko');
    assert.strictEqual(status.available, true);
    assert(status.degradedReason.includes('forced garu analyze failure'));
    assert(meta.tokenizer_degraded_reason.includes('forced garu analyze failure'));
  }

  {
    const fake = createFakeGaru();
    const tokenizer = createKeywordTokenizer({
      provider: 'garu',
      maxAnalysisChars: 40,
      loadGaru: async () => fake
    });
    await tokenizer.initialize();

    const longText = '# 전자문서 관리 시스템\n' + '가'.repeat(200) + '\nunboundedtailtoken 먹었다';
    const tokens = tokenizer.tokenize(longText);
    const searchText = tokenizer.buildSearchText(longText);

    assert(fake.calls[0].length <= 40, 'garu receives bounded enrichment text, not full markdown body');
    assert(!tokens.includes('unboundedtailtoken'), 'basic tokenizer receives bounded enrichment text, not full markdown body');
    assert(!searchText.includes('unboundedtailtoken'), 'search_text omits tokens beyond the bounded analysis window');
    assert(searchText.includes('전자'), 'search_text includes garu token from heading/title');
    assert(searchText.includes('전자문서'), 'search_text preserves existing tokenizer compound token');
  }

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-garu-contract-'));
    const dbPath = path.join(root, 'index.sqlite3');
    const fake = createFakeGaru();
    const tokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => fake
    });
    await tokenizer.initialize();

    const index = new SQLiteKeywordIndex({
      dbPath,
      sourceRoot: root,
      tokenizer
    });

    try {
      index.rebuild([
        makeDocument(path.join(root, 'lunch.md'), '# 점심\n\n학교에서 점심을 먹었다'),
        makeDocument(path.join(root, 'other.md'), '# 기타\n\n아무 내용')
      ]);

      const results = index.search('먹다', { limit: 5 });
      assert.strictEqual(results.length, 1, 'garu tokenized query matches inflected document token');
      assert.strictEqual(results[0].filePath, path.join(root, 'lunch.md'));
      const meta = index.loadIndexMetadata();
      assert.strictEqual(meta.tokenizer_provider, 'garu-ko');
      assert.strictEqual(meta.tokenizer_version, 'fake-garu');
    } finally {
      index.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const tokenizer = createBasicKeywordTokenizer();
    const tokens = tokenizer.tokenize('전자문서 관리 시스템');
    assert(tokens.includes('전자문서'), 'basic tokenizer remains available for compatibility');
  }

  {
    const tokenizer = createKeywordTokenizer({ provider: 'garu' });
    await tokenizer.initialize();
    const tokens = tokenizer.tokenize('라이선스를 사용할 수 없습니다');
    assert(tokens.includes('라이선스'), 'real garu-ko dependency strips Korean particles');
    assert(tokens.includes('사용'), 'real garu-ko dependency extracts content noun');
  }

  console.log('test-garu-tokenizer-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
