// PDF.js validates a literal trailing '/', even when Node reads a Windows path.
// Keep these as filesystem paths: its NodeBinaryDataFactory uses fs.readFile.
export function pdfResourcePaths(root) {
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    cMapUrl: `${base}/cmaps/`,
    standardFontDataUrl: `${base}/standard_fonts/`,
  };
}
