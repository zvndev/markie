const fs = require("node:fs");

// The classic editor saves UTF-8 strings. UTF-16 text must instead enter the
// byte-preserving document engine before any UTF-8 decode can lose its BOM or
// characters. Called only after the main process has authorized the path.
function hasUtf16Bom(filePath, io = fs) {
  const fd = io.openSync(filePath, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0));
  try {
    if (!io.fstatSync(fd).isFile()) throw new Error("Choose a regular text file.");
    const prefix = Buffer.alloc(2);
    let count = 0;
    while (count < prefix.length) {
      const read = io.readSync(fd, prefix, count, prefix.length - count, count);
      if (!read) break;
      count += read;
    }
    return count === 2 && ((prefix[0] === 255 && prefix[1] === 254) || (prefix[0] === 254 && prefix[1] === 255));
  } finally {
    io.closeSync(fd);
  }
}

function needsBytePreservingText(fileName, content) {
  return /\.(?:txt|text|log)$/i.test(fileName)
    && (content.startsWith("\uFEFF") || content.includes("\r"));
}

module.exports = { hasUtf16Bom, needsBytePreservingText };
