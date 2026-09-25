import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pdfResourcePaths } from './pdf-resources.js';

const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
let task;
try {
  task = getDocument({
    data: workerData.bytes, password: '', useWorkerFetch: false, useWasm: false,
    stopAtErrors: true, disableFontFace: true, useSystemFonts: false,
    isEvalSupported: false, enableXfa: false, verbosity: 0,
    ...pdfResourcePaths(root), cMapPacked: true,
  });
  const doc = await task.promise;
  if (doc.numPages > workerData.maxPages) throw new Error('PDF 超过 300 页处理上限，未截断概括');
  const pages = []; let length = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.filter(item => typeof item.str === 'string')
      .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
    // Never describe a partly image-only or unextractable PDF as fully read.
    if (text.replace(/\s/g, '').length < 40) throw new Error(`PDF 第 ${i} 页文本不足，未完成正文读取`);
    const section = `[PDF page ${i}/${doc.numPages}]\n${text}`;
    length += section.length + 2;
    if (length > workerData.maxChars) throw new Error('正文超过 48 万字符处理上限，未截断概括');
    pages.push(section); page.cleanup();
  }
  const text = pages.join('\n\n');
  if (text.length < 1200) throw new Error('PDF 正文过短，未生成概括');
  parentPort.postMessage({text, pages: doc.numPages});
} catch (error) {
  const message = String(error?.message || '');
  parentPort.postMessage({error: /^PDF |^正文/.test(message) ? message : 'PDF 无法完整提取文本，未生成概括',
    cause: {name: error?.name || 'Error', message: message.slice(0, 1500)}});
} finally {
  await task?.destroy().catch(() => {});
}
