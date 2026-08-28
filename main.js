const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// Load .env - trong production lấy từ extraResources
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, ".env")
  : path.join(__dirname, ".env");

require("dotenv").config({ path: envPath });

let mainWindow = null;
let serverStarted = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "TCSS Bot",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
  });

  // Chờ server sẵn sàng rồi mới load
  const waitForServer = () => {
    if (serverStarted) {
      mainWindow.loadURL("http://localhost:3000");
    } else {
      setTimeout(waitForServer, 200);
    }
  };
  waitForServer();

  // Mở link external trong browser mặc định
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Khởi động Express server trong cùng process
function startServer() {
  // Set biến để server.js biết đang chạy trong Electron
  process.env.ELECTRON = "1";

  const { startApp } = require("./server");
  startApp(() => {
    serverStarted = true;
    console.log("[Electron] Server đã sẵn sàng");
  });
}

app.whenReady().then(() => {
  // Nhận video buffer từ renderer và lưu ra file
  ipcMain.on("save-video", (event, { buffer, filename }) => {
    const savePath = path.join(app.getPath("downloads"), filename);
    fs.writeFile(savePath, Buffer.from(buffer), (err) => {
      if (err) {
        console.error("[Main] Lỗi lưu video:", err.message);
        event.reply("save-video-result", { success: false, error: err.message });
      } else {
        console.log(`[Main] ✅ Video đã lưu: ${savePath}`);
        event.reply("save-video-result", { success: true, path: savePath });
        shell.showItemInFolder(savePath);
      }
    });
  });

  startServer();
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

app.on("before-quit", () => {
  // Cleanup - dừng tất cả bot trước khi thoát
  try {
    const { stopAll } = require("./server");
    if (stopAll) stopAll();
  } catch (_) {}
});
