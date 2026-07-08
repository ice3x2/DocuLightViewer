'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { saveMcpUpdatedContent } = require('../src/main/mcp-save');
const { parseFrontmatter } = require('../src/main/frontmatter');

function createStore(dir) {
  return {
    _data: {
      mcpAutoSave: true,
      mcpAutoSavePath: dir,
      mcpSaveSubDir: '{project}/{type}'
    },
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue;
    }
  };
}

function createWindowManager() {
  const entries = new Map();
  let nextId = 1;
  return {
    entries,
    async createWindow(opts) {
      const windowId = String(nextId++);
      const fmData = opts.content ? parseFrontmatter(opts.content).data : {};
      entries.set(windowId, {
        meta: {
          title: opts.title || 'Untitled',
          project: opts.project || fmData.project || null,
          docType: opts.docType || fmData.docType || null,
          severity: opts.severity || null,
          lastRenderedContent: opts.content || '',
          savedFilePath: null
        },
        win: {
          isDestroyed: () => false,
          setAlwaysOnTop() {},
          setTitle() {},
          webContents: {
            send() {}
          }
        }
      });
      return { windowId, title: opts.title || 'Untitled', upserted: false };
    },
    async updateWindow(windowId, opts) {
      const entry = entries.get(String(windowId));
      if (!entry) throw new Error('missing window');
      if (opts.appendMode) {
        entry.meta.lastRenderedContent = `${entry.meta.lastRenderedContent}\n\n${opts.content}`;
      } else if (opts.filePath) {
        entry.meta.filePath = opts.filePath;
        entry.meta.lastRenderedContent = fs.readFileSync(opts.filePath, 'utf-8');
      } else if (opts.content != null) {
        entry.meta.lastRenderedContent = opts.content;
      }
      if (opts.title) entry.meta.title = opts.title;
      if (opts.project) entry.meta.project = opts.project;
      if (opts.docType) entry.meta.docType = opts.docType;
      return { title: entry.meta.title };
    },
    getWindowEntry(windowId) {
      return entries.get(String(windowId));
    }
  };
}

function listMdFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(fullPath);
    }
  }
  return found;
}

(async () => {
  const { createToolHandlers, TOOLS } = await import('../src/main/mcp-http.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-http-save-'));
  try {
    const store = createStore(tmpDir);
    const windowManager = createWindowManager();
    const searchEngine = {
      dirtyCount: 0,
      ensureFreshCount: 0,
      docMeta: new Map(),
      markDirty() {
        this.dirtyCount += 1;
      },
      async ensureFresh() {
        this.ensureFreshCount += 1;
        return { rebuilt: false, stale: true };
      },
      search(query, { limit } = {}) {
        return [{
          filePath: path.join(tmpDir, 'ProjectParity', 'guide', 'smart.md'),
          score: 1,
          title: `Smart Result ${tmpDir} api_key=secret`,
          project: 'ProjectParity',
          docType: 'guide',
          category: 'research',
          documentTags: ['wave2', 'password=secret'],
          snippet: `snippet ${query} ${tmpDir}`
        }].slice(0, limit || 20);
      },
      getStatus() {
        return {
          state: 'ready',
          currentPath: path.join(tmpDir, 'secret.md'),
          indexPath: path.join(tmpDir, 'userData', 'index.sqlite3'),
          dataDir: path.join(tmpDir, 'userData'),
          failedFiles: [{ filePath: path.join(tmpDir, 'failed.md'), error: 'api_key=secret' }]
        };
      },
      getIndexDataDir() {
        return path.join(tmpDir, 'userData', 'index');
      }
    };
    const handlers = createToolHandlers(windowManager, store, searchEngine);

    assert.strictEqual(TOOLS.length, 8, 'HTTP MCP tool surface exposes eight tools');
    assert(!TOOLS.some((tool) => /index|rebuild|compact|clear/i.test(tool.name)), 'HTTP MCP has no indexing control tools');
    assert(TOOLS.some((tool) => tool.name === 'save_document'), 'HTTP MCP exposes save_document');

    const initialWindowCount = windowManager.entries.size;
    const saveDocumentResult = await handlers.save_document({
      content: '# Save Only\n\nunique-save-document-marker',
      title: 'Save Only',
      project: 'ProjectParity',
      docType: 'guide',
      category: 'research',
      documentTags: ['wave2', 'save-document']
    });
    assert.strictEqual(windowManager.entries.size, initialWindowCount, 'save_document does not create a viewer window');
    const saveDocumentPayload = JSON.parse(saveDocumentResult.content[0].text);
    assert.strictEqual(saveDocumentPayload.schemaVersion, 'save_document.v1', 'save_document returns canonical schema version');
    assert.strictEqual(saveDocumentPayload.saved, true, 'save_document reports saved=true');
    assert(saveDocumentPayload.documentId, 'save_document returns documentId');
    assert.strictEqual(saveDocumentPayload.indexing.state, 'degraded', 'fake search engine reports degraded enqueue state without failing save');
    assert(!JSON.stringify(saveDocumentPayload).includes(tmpDir), 'save_document response does not leak raw absolute path');
    const saveOnlyFiles = listMdFiles(tmpDir).filter((file) => fs.readFileSync(file, 'utf-8').includes('unique-save-document-marker'));
    assert.strictEqual(saveOnlyFiles.length, 1, 'save_document writes exactly one markdown file');
    let dirtyAfterSaveDocument = searchEngine.dirtyCount;

    const collisionA = await handlers.save_document({
      content: '# Collision\n\nfirst same-title save',
      title: 'Collision',
      project: 'ProjectParity',
      docType: 'guide'
    });
    const collisionB = await handlers.save_document({
      content: '# Collision\n\nsecond same-title save',
      title: 'Collision',
      project: 'ProjectParity',
      docType: 'guide'
    });
    const collisionPayloadA = JSON.parse(collisionA.content[0].text);
    const collisionPayloadB = JSON.parse(collisionB.content[0].text);
    assert.notStrictEqual(collisionPayloadA.sourceRelativePath, collisionPayloadB.sourceRelativePath, 'same-title save_document calls do not overwrite within the same second');
    const collisionFiles = listMdFiles(tmpDir).filter((file) => fs.readFileSync(file, 'utf-8').includes('same-title save'));
    assert.strictEqual(collisionFiles.length, 2, 'same-title save_document calls persist separate files');

    const frontmatterTags = await handlers.save_document({
      content: '---\ndocumentTags:\n  - fm-wave\n  - fm-list\ncategory: notes\n---\n# Frontmatter Tags\n\nBody',
      title: 'Frontmatter Tags',
      project: 'ProjectParity',
      docType: 'guide'
    });
    const frontmatterTagsPayload = JSON.parse(frontmatterTags.content[0].text);
    assert(frontmatterTagsPayload.documentTags.includes('fm-wave'), 'save_document preserves YAML-list documentTags from frontmatter');

    const existingGitFrontmatterInput = String.raw`---
projectPath: C:\Users\secret\repo
gitRemote: "https://example.test/repo.git?token=frontsecret"
gitBranch: secret-branch
gitLastCommit: secret commit
---
# Existing Git Frontmatter

existing git frontmatter redaction fixture`;
    await handlers.save_document({
      content: existingGitFrontmatterInput,
      title: 'Existing Git Frontmatter',
      project: 'ProjectParity',
      docType: 'guide'
    });
    const existingGitFrontmatterFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('existing git frontmatter redaction fixture'));
    assert(existingGitFrontmatterFile, 'save_document writes existing git frontmatter fixture file');
    const existingGitFrontmatterContent = fs.readFileSync(existingGitFrontmatterFile, 'utf-8');
    assert(!existingGitFrontmatterContent.includes('projectPath:'), 'save_document strips existing projectPath frontmatter');
    assert(!existingGitFrontmatterContent.includes('gitRemote:'), 'save_document strips existing gitRemote frontmatter when no sanitized git context remote is present');
    assert(!existingGitFrontmatterContent.includes('frontsecret'), 'save_document strips credential-like existing gitRemote frontmatter values');
    assert(!existingGitFrontmatterContent.includes('gitBranch:'), 'save_document strips existing gitBranch frontmatter');
    assert(!existingGitFrontmatterContent.includes('gitLastCommit:'), 'save_document strips existing gitLastCommit frontmatter');

    const gitRepo = path.join(os.tmpdir(), `doculight-git-context-${process.pid}`);
    fs.rmSync(gitRepo, { recursive: true, force: true });
    fs.mkdirSync(gitRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: gitRepo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/repo.git?token=rawsecret'], { cwd: gitRepo, stdio: 'ignore' });
    try {
      const gitContextResult = await handlers.save_document({
        content: '# Git Context\n\nraw gitContextPath redaction fixture',
        title: 'Git Context',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const gitContextPayload = JSON.parse(gitContextResult.content[0].text);
      assert.strictEqual(gitContextPayload.saved, true, 'save_document accepts safe local gitContextPath');
      const gitContextFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('raw gitContextPath redaction fixture'));
      assert(gitContextFile, 'save_document writes gitContextPath fixture file');
      const gitContextContent = fs.readFileSync(gitContextFile, 'utf-8');
      assert(!gitContextContent.includes(gitRepo), 'save_document frontmatter does not persist raw gitContextPath/projectPath');
      assert(!gitContextContent.includes('rawsecret'), 'save_document frontmatter does not persist credential-like git remote query values');
      assert(!gitContextContent.includes('token='), 'save_document frontmatter does not persist credential query keys');

      execFileSync('git', ['remote', 'set-url', 'origin', '../private-local-repo.git'], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git Relative Remote\n\nrelative git remote redaction fixture',
        title: 'Git Relative Remote',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const gitRelativeRemoteFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('relative git remote redaction fixture'));
      assert(gitRelativeRemoteFile, 'save_document writes relative git remote fixture file');
      const gitRelativeRemoteContent = fs.readFileSync(gitRelativeRemoteFile, 'utf-8');
      assert(!gitRelativeRemoteContent.includes('../private-local-repo.git'), 'save_document frontmatter does not persist path-like relative git remote values');

      const scpWindowsRemote = String.raw`git@example.test:C:\Users\secret\repo.git`;
      execFileSync('git', ['remote', 'set-url', 'origin', scpWindowsRemote], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git SCP Windows Remote\n\nscp windows remote redaction fixture',
        title: 'Git SCP Windows Remote',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const scpWindowsRemoteFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('scp windows remote redaction fixture'));
      assert(scpWindowsRemoteFile, 'save_document writes SCP Windows remote fixture file');
      const scpWindowsRemoteContent = fs.readFileSync(scpWindowsRemoteFile, 'utf-8');
      assert(!scpWindowsRemoteContent.includes(scpWindowsRemote), 'save_document frontmatter does not persist SCP-like Windows absolute git remote values');
      assert(!scpWindowsRemoteContent.includes(String.raw`C:\Users\secret`), 'save_document frontmatter does not persist SCP-like Windows absolute git remote path segments');

      execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.test/org/token=rawsecret/repo.git'], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git URL Path Credential\n\nurl path credential redaction fixture',
        title: 'Git URL Path Credential',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const urlPathCredentialFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('url path credential redaction fixture'));
      assert(urlPathCredentialFile, 'save_document writes URL path credential fixture file');
      const urlPathCredentialContent = fs.readFileSync(urlPathCredentialFile, 'utf-8');
      assert(!urlPathCredentialContent.includes('token=rawsecret'), 'save_document frontmatter does not persist URL path credential assignment segments');

      execFileSync('git', ['remote', 'set-url', 'origin', 'git@example.test:org/token=rawsecret/repo.git'], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git SCP Path Credential\n\nscp path credential redaction fixture',
        title: 'Git SCP Path Credential',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const scpPathCredentialFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('scp path credential redaction fixture'));
      assert(scpPathCredentialFile, 'save_document writes SCP path credential fixture file');
      const scpPathCredentialContent = fs.readFileSync(scpPathCredentialFile, 'utf-8');
      assert(!scpPathCredentialContent.includes('token=rawsecret'), 'save_document frontmatter does not persist SCP path credential assignment segments');

      execFileSync('git', ['remote', 'set-url', 'origin', 'bearer=rawsecret@example.test:repo.git'], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git SCP User Credential\n\nscp user credential redaction fixture',
        title: 'Git SCP User Credential',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const scpUserCredentialFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('scp user credential redaction fixture'));
      assert(scpUserCredentialFile, 'save_document writes SCP user credential fixture file');
      const scpUserCredentialContent = fs.readFileSync(scpUserCredentialFile, 'utf-8');
      assert(!scpUserCredentialContent.includes('bearer=rawsecret'), 'save_document frontmatter does not persist SCP user credential assignment values');

      execFileSync('git', ['remote', 'set-url', 'origin', 'git@bearer=rawsecret.example:repo.git'], { cwd: gitRepo, stdio: 'ignore' });
      await handlers.save_document({
        content: '# Git SCP Host Credential\n\nscp host credential redaction fixture',
        title: 'Git SCP Host Credential',
        project: 'ProjectParity',
        docType: 'guide',
        gitContextPath: gitRepo
      });
      const scpHostCredentialFile = listMdFiles(tmpDir).find((file) => fs.readFileSync(file, 'utf-8').includes('scp host credential redaction fixture'));
      assert(scpHostCredentialFile, 'save_document writes SCP host credential fixture file');
      const scpHostCredentialContent = fs.readFileSync(scpHostCredentialFile, 'utf-8');
      assert(!scpHostCredentialContent.includes('bearer=rawsecret'), 'save_document frontmatter does not persist SCP host credential assignment values');
    } finally {
      fs.rmSync(gitRepo, { recursive: true, force: true });
    }

    const smartSearchResult = await handlers.smart_search({
      query: 'needle',
      includeDiagnostics: true,
      includeScores: true,
      filters: { project: 'ProjectParity', docType: 'guide', category: 'research', documentTags: ['wave2'], pathPrefix: 'ProjectParity/' }
    });
    const smartPayloadText = smartSearchResult.content[0].text;
    const smartPayload = JSON.parse(smartPayloadText);
    assert.strictEqual(smartPayload.results[0].sourceRelativePath, 'ProjectParity/guide/smart.md', 'smart_search exposes source-relative result path');
    assert(!smartPayloadText.includes(tmpDir), 'smart_search response and diagnostics redact raw absolute paths');
    assert(!smartPayloadText.includes('secret'), 'smart_search diagnostics redact credential-like text');
    const noDegraded = await handlers.smart_search({ query: 'needle', allowDegraded: false });
    assert.strictEqual(noDegraded.isError, true, 'smart_search honors allowDegraded=false for keyword-only degraded mode');
    const keywordSearchResult = await handlers.search_documents({ query: 'needle' });
    assert.strictEqual(searchEngine.ensureFreshCount, 1, 'HTTP search_documents performs a freshness compatibility check before querying');
    assert(keywordSearchResult.content[0].text.includes('Found 1 result'), 'HTTP search_documents still returns the keyword compatibility envelope');
    dirtyAfterSaveDocument = searchEngine.dirtyCount;

    const forbiddenSaveResult = await handlers.save_document({
      content: '# Invalid',
      filePath: path.join(tmpDir, 'leak.md')
    });
    assert.strictEqual(forbiddenSaveResult.isError, true, 'save_document rejects forbidden filePath field');
    const forbiddenPayload = JSON.parse(forbiddenSaveResult.content[0].text);
    assert.strictEqual(forbiddenPayload.error.code, 'validation_failed', 'forbidden save_document field returns validation_failed');
    assert(!JSON.stringify(forbiddenPayload).includes(tmpDir), 'validation failure does not echo raw path');

    const urlGitContext = 'https://example.test/private/repo.git?token=rawsecret';
    const urlGitContextResult = await handlers.save_document({
      content: '# Invalid Git Context URL',
      gitContextPath: urlGitContext
    });
    const urlGitContextPayload = JSON.parse(urlGitContextResult.content[0].text);
    assert.strictEqual(urlGitContextResult.isError, true, 'save_document rejects URL-like gitContextPath');
    assert.strictEqual(urlGitContextPayload.error.code, 'validation_failed', 'URL-like gitContextPath returns validation_failed');
    assert(!JSON.stringify(urlGitContextPayload).includes(urlGitContext), 'URL-like gitContextPath failure does not echo raw value');
    assert(!JSON.stringify(urlGitContextPayload).includes('rawsecret'), 'URL-like gitContextPath failure redacts credential-like text');

    const credentialGitContext = `${path.join(tmpDir, 'repo')}?token=rawsecret`;
    const credentialGitContextResult = await handlers.save_document({
      content: '# Invalid Git Context Credential',
      gitContextPath: credentialGitContext
    });
    const credentialGitContextPayload = JSON.parse(credentialGitContextResult.content[0].text);
    assert.strictEqual(credentialGitContextResult.isError, true, 'save_document rejects credential-bearing gitContextPath');
    assert.strictEqual(credentialGitContextPayload.error.code, 'validation_failed', 'credential-bearing gitContextPath returns validation_failed');
    assert(!JSON.stringify(credentialGitContextPayload).includes(credentialGitContext), 'credential-bearing gitContextPath failure does not echo raw value');
    assert(!JSON.stringify(credentialGitContextPayload).includes('rawsecret'), 'credential-bearing gitContextPath failure redacts credential-like text');

    const credentialSegmentGitContext = path.join(os.tmpdir(), `doculight-token=rawsecret-${process.pid}`, 'repo');
    const credentialSegmentGitContextResult = await handlers.save_document({
      content: '# Invalid Git Context Credential Segment',
      gitContextPath: credentialSegmentGitContext
    });
    const credentialSegmentGitContextPayload = JSON.parse(credentialSegmentGitContextResult.content[0].text);
    assert.strictEqual(credentialSegmentGitContextResult.isError, true, 'save_document rejects credential-bearing gitContextPath path segment');
    assert.strictEqual(credentialSegmentGitContextPayload.error.code, 'validation_failed', 'credential-bearing gitContextPath segment returns validation_failed');
    assert(!JSON.stringify(credentialSegmentGitContextPayload).includes(credentialSegmentGitContext), 'credential-bearing gitContextPath segment failure does not echo raw value');
    assert(!JSON.stringify(credentialSegmentGitContextPayload).includes('rawsecret'), 'credential-bearing gitContextPath segment failure redacts credential-like text');

    const rootOverrideResult = await handlers.save_document({
      content: '# Invalid Git Context Root Override',
      gitContextPath: tmpDir
    });
    const rootOverridePayload = JSON.parse(rootOverrideResult.content[0].text);
    assert.strictEqual(rootOverrideResult.isError, true, 'save_document rejects gitContextPath inside configured save root');
    assert.strictEqual(rootOverridePayload.error.code, 'validation_failed', 'save-root gitContextPath returns validation_failed');
    assert(!JSON.stringify(rootOverridePayload).includes(tmpDir), 'save-root gitContextPath failure does not echo configured root');

    const openResult = await handlers.open_markdown({
      content: '# Saved\n\nInitial body',
      title: 'Initial',
      project: 'ProjectParity',
      docType: 'guide'
    });
    const windowId = (openResult.content[0].text.match(/windowId:\s*(\S+)/) || [])[1];
    assert(windowId, 'open_markdown returns a window id');

    const openedFiles = listMdFiles(tmpDir).filter((file) => fs.readFileSync(file, 'utf-8').includes('Initial body'));
    assert.strictEqual(openedFiles.length, 1, 'HTTP open_markdown saves one file');
    assert(openedFiles[0].includes(`${path.sep}ProjectParity${path.sep}guide${path.sep}`), 'HTTP open_markdown passes project/docType into save path');
    assert.strictEqual(searchEngine.dirtyCount, dirtyAfterSaveDocument + 1, 'HTTP open_markdown marks search index dirty after save');

    const frontmatterOnlyResult = await handlers.open_markdown({
      content: '---\nproject: FromFrontmatter\ndocType: guide\n---\n# From Frontmatter\n\nBody',
      title: 'Frontmatter Only'
    });
    const frontmatterOnlyId = (frontmatterOnlyResult.content[0].text.match(/windowId:\s*(\S+)/) || [])[1];
    assert(frontmatterOnlyId, 'frontmatter-only open_markdown returns a window id');
    const frontmatterFiles = listMdFiles(tmpDir).filter((file) => file.includes(`${path.sep}FromFrontmatter${path.sep}guide${path.sep}`));
    assert.strictEqual(frontmatterFiles.length, 1, 'HTTP open_markdown uses frontmatter project/docType when explicit metadata is absent');
    assert.strictEqual(searchEngine.dirtyCount, dirtyAfterSaveDocument + 2, 'frontmatter-only open_markdown marks search index dirty after save');

    await handlers.update_markdown({
      windowId,
      content: 'Append fragment',
      appendMode: true
    });
    const appendedContent = fs.readFileSync(openedFiles[0], 'utf-8');
    assert(appendedContent.includes('Initial body'), 'appendMode persistence keeps previous canonical content');
    assert(appendedContent.includes('Append fragment'), 'appendMode persistence includes appended content');
    assert.strictEqual(searchEngine.dirtyCount, dirtyAfterSaveDocument + 3, 'HTTP update_markdown marks dirty after saved update');

    await handlers.update_markdown({
      windowId,
      content: '# No Save',
      noSave: true
    });
    assert.strictEqual(fs.readFileSync(openedFiles[0], 'utf-8'), appendedContent, 'noSave update does not touch saved file');
    assert.strictEqual(searchEngine.dirtyCount, dirtyAfterSaveDocument + 3, 'noSave update does not mark dirty');

    const sourceFile = path.join(tmpDir, 'source-update.md');
    fs.writeFileSync(sourceFile, '# File Update\n\nFile body saved from filePath.', 'utf-8');
    await handlers.update_markdown({
      windowId,
      filePath: sourceFile,
      title: 'File Update'
    });
    const filePathUpdateContent = fs.readFileSync(openedFiles[0], 'utf-8');
    assert(filePathUpdateContent.includes('File body saved from filePath'), 'filePath update persists canonical file content');
    assert.strictEqual(searchEngine.dirtyCount, dirtyAfterSaveDocument + 4, 'filePath update marks dirty after saved update');

    const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf-8');
    const httpSource = fs.readFileSync(path.join(__dirname, '../src/main/mcp-http.mjs'), 'utf-8');
    const windowManagerSource = fs.readFileSync(path.join(__dirname, '../src/main/window-manager.js'), 'utf-8');
    assert(mainSource.includes('saveMcpUpdatedContent'), 'stdio IPC update path uses shared MCP update save helper');
    assert(httpSource.includes('saveMcpUpdatedContent'), 'HTTP MCP update path uses shared MCP update save helper');
    assert(windowManagerSource.includes('project: resolvedProjectMeta'), 'real WindowManager stores project metadata from params or frontmatter');

    const sharedEntry = {
      meta: {
        title: 'Shared Fixture',
        project: 'ProjectParity',
        docType: 'guide',
        lastRenderedContent: '# Shared Fixture\n\nSame canonical content.',
        savedFilePath: null
      }
    };
    const sharedSearchEngine = { dirtyCount: 0, markDirty() { this.dirtyCount += 1; } };
    const sharedResult = await saveMcpUpdatedContent(store, sharedEntry, {}, sharedSearchEngine);
    assert(sharedResult.savedPath.includes(`${path.sep}ProjectParity${path.sep}guide${path.sep}`), 'shared stdio/http helper resolves same project/docType fixture path');
    assert(fs.readFileSync(sharedResult.savedPath, 'utf-8').includes('Same canonical content'), 'shared helper persists canonical content for stdio/http parity fixture');
    assert.strictEqual(sharedSearchEngine.dirtyCount, 1, 'shared helper marks dirty after saved parity fixture');

    const disabledStore = {
      get(key, defaultValue) {
        if (key === 'mcpAutoSave') return false;
        if (key === 'mcpAutoSavePath') return '';
        return defaultValue;
      }
    };
    const disabledHandlers = createToolHandlers(windowManager, disabledStore, {
      docMeta: new Map(),
      getStatus() {
        return { state: 'uninitialized' };
      },
      search() {
        return [];
      },
      searchProjects() {
        return [];
      }
    });
    const disabledSearch = await disabledHandlers.search_documents({ query: 'needle' });
    assert.strictEqual(disabledSearch.isError, true, 'HTTP search_documents errors when mcpAutoSave is not configured');
    assert(disabledSearch.content[0].text.includes('mcpAutoSave'), 'HTTP search_documents error mentions mcpAutoSave');
    const disabledProjects = await disabledHandlers.search_projects({});
    assert.strictEqual(disabledProjects.isError, true, 'HTTP search_projects errors when mcpAutoSave is not configured');
    const disabledSave = await disabledHandlers.save_document({ content: '# Disabled' });
    const disabledSavePayload = JSON.parse(disabledSave.content[0].text);
    assert.strictEqual(disabledSave.isError, true, 'save_document errors when storage is not configured');
    assert.strictEqual(disabledSavePayload.error.code, 'storage_not_configured', 'save_document reports storage_not_configured');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('test-mcp-http-save-parity: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
