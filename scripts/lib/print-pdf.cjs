// Prints one HTML file to PDF with the exporter's own printToPDF options.
// Runs under Electron because printToPDF is Chromium's, and one file per
// invocation because a second loadURL in the same process races the first
// window's teardown and fails with ERR_FAILED.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const url = require("url");

const [dir, name] = process.argv.slice(2);
// Kept in step with PRINT_OPTIONS in electron/export-pdf.js on purpose: a
// check that prints with different options is not checking the export.
const PRINT_OPTIONS = {
  printBackground: true,
  preferCSSPageSize: true,
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
};

app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 1200 });
    await win.loadURL(url.pathToFileURL(path.join(dir, `${name}.html`)).toString());
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(path.join(dir, `${name}.pdf`), await win.webContents.printToPDF(PRINT_OPTIONS));
    win.destroy();
  } catch (err) {
    fs.writeFileSync(path.join(dir, `${name}.error`), String((err && err.stack) || err));
    code = 1;
  }
  app.exit(code);
});
