const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  net,
} = require("electron");
const path = require("path");
const fs = require("fs");
const url = require("url");

const isDev = process.env.NODE_ENV === "development";

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL("app://marker/index.html");
  }
}

// Register custom protocol to serve static files with proper MIME types
function registerProtocol() {
  protocol.handle("app", (request) => {
    const requestUrl = new URL(request.url);
    // Remove the host part and decode the path
    let filePath = decodeURIComponent(requestUrl.pathname);

    // Resolve to the out directory
    const outDir = path.join(__dirname, "../out");
    const fullPath = path.join(outDir, filePath);

    // If path doesn't exist, try adding .html
    if (!fs.existsSync(fullPath) && !path.extname(fullPath)) {
      const htmlPath = fullPath + ".html";
      if (fs.existsSync(htmlPath)) {
        return net.fetch(url.pathToFileURL(htmlPath).toString());
      }
    }

    // If it's a directory, serve index.html
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      const indexPath = path.join(fullPath, "index.html");
      if (fs.existsSync(indexPath)) {
        return net.fetch(url.pathToFileURL(indexPath).toString());
      }
    }

    return net.fetch(url.pathToFileURL(fullPath).toString());
  });
}

// IPC: Open file dialog
ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
      { name: "Text", extensions: ["txt"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf-8");
  const name = path.basename(filePath);

  return { name, content, path: filePath };
});

// IPC: Export PDF — render standalone HTML in hidden window, then printToPDF
ipcMain.handle("export-pdf", async (_event, html) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: "document.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });

  if (result.canceled || !result.filePath) {
    return { success: false };
  }

  // Create a hidden window to render the styled HTML
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Load the HTML as a data URL
  const dataUrl =
    "data:text/html;charset=utf-8," + encodeURIComponent(html);
  await pdfWindow.loadURL(dataUrl);

  // Wait a moment for fonts/rendering to settle
  await new Promise((resolve) => setTimeout(resolve, 500));

  const pdfData = await pdfWindow.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  fs.writeFileSync(result.filePath, pdfData);
  pdfWindow.close();

  return { success: true, path: result.filePath };
});

// IPC: Open file from path (for "open with" and drag-drop from Finder)
ipcMain.handle("open-file-path", async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(filePath);
    return { name, content, path: filePath };
  } catch {
    return null;
  }
});

// App menu
const template = [
  {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "File",
    submenu: [
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => {
          mainWindow?.webContents.send("menu-open-file");
        },
      },
      { type: "separator" },
      {
        label: "Export PDF…",
        accelerator: "CmdOrCtrl+Shift+E",
        click: () => {
          mainWindow?.webContents.send("menu-export-pdf");
        },
      },
      { type: "separator" },
      { role: "close" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      {
        label: "Edit Mode",
        accelerator: "CmdOrCtrl+1",
        click: () => mainWindow?.webContents.send("set-mode", "edit"),
      },
      {
        label: "Split Mode",
        accelerator: "CmdOrCtrl+2",
        click: () => mainWindow?.webContents.send("set-mode", "split"),
      },
      {
        label: "Preview Mode",
        accelerator: "CmdOrCtrl+3",
        click: () => mainWindow?.webContents.send("set-mode", "preview"),
      },
      { type: "separator" },
      { role: "togglefullscreen" },
      { type: "separator" },
      { role: "toggleDevTools" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { role: "front" },
    ],
  },
];

app.whenReady().then(() => {
  registerProtocol();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Handle file open via command line args or "open with"
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    const content = fs.readFileSync(filePath, "utf-8");
    const name = path.basename(filePath);
    mainWindow.webContents.send("file-opened", {
      name,
      content,
      path: filePath,
    });
  }
});
