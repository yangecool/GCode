import { recordArmsCustomEventForE2E } from "@gcode/ui";
import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@gcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.gcode.selectDirectory(),
    selectFile: () => window.gcode.selectFile(),
    selectFiles: () => window.gcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.gcode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.gcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.gcode.onRemoteSessionClosed(handler),
    activateOrSetWorkspace: (path) =>
      window.gcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.gcode.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.gcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.gcode.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    disposeRemoteSession: (sessionId) => window.gcode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.gcode.isDockerAvailable(),
    listWSLDistros: () => window.gcode.listWSLDistros(),
    listDockerContainers: () => window.gcode.listDockerContainers(),
    listSSHConfigAliases: () => window.gcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.gcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.gcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.gcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.gcode.openExternal(url),
    openFeedback: () => window.gcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.gcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.gcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.gcode.openInFileManager(path),
    openExternalFile: (path) => window.gcode.openExternalFile(path),
    openCuaPermissionOnboarding: window.gcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.gcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.gcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.gcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.gcode.startCuaHelperPermissionDrag
      ? () => window.gcode.startCuaHelperPermissionDrag?.()
      : undefined,
    registerOAuthState: (payload) => window.gcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.gcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.gcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.gcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.gcode.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.gcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.gcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.gcode.getRendererActionTraceConfig
      ? () => window.gcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.gcode.onRendererActionTraceConfigChanged
      ? (callback) => window.gcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.gcode.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.gcode.reportRendererActionTraceBatch
      ? (batch) => window.gcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.gcode.reportRendererHeapSample
      ? (sample) => window.gcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.gcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.gcode.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.gcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.gcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.gcode.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.gcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.gcode.onFocusTab(handler),
    onNewTab: (handler) => window.gcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.gcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.gcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.gcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.gcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.gcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.gcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.gcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.gcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.gcode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.gcode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.gcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.gcode.getDesktopWindowChromeState
      ? () => window.gcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.gcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.gcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.gcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.gcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.gcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.gcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.gcode.onTaskNotificationClick(handler),
    exportLogs: () => window.gcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.gcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.gcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.gcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.gcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.gcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.gcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.gcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.gcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.gcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.gcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.gcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getGCodeStdioTapDevState: () =>
      window.gcode.getGCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.gcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.gcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.gcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.gcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.gcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.gcode.quitAndInstallUpdate(),
    getInstalledEditors: () => window.gcode.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.gcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.gcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.gcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.gcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.gcode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.gcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __GCODE_DEVICE_ID__?: string }).__GCODE_DEVICE_ID__ ?? "",
  };
}
