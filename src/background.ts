;
/**
 * Service worker entry. All chrome.* listeners are wired here; the
 * implementation lives in the ./background/* modules.
 */
import { onMessagePing, watchEnabledChanges } from "./background/appStatus";
import { createContextMenu, handleContextMenuClick } from "./background/contextMenu";
import { handleDownloadCreated } from "./background/interception";
import { startHeaderCapture } from "./background/requestCache";


// Header capture must register before any download can be intercepted.
startHeaderCapture()

chrome.contextMenus.onClicked.addListener((info: any) => {
  void handleContextMenuClick(info)
})

chrome.runtime.onInstalled.addListener(() => {
  void createContextMenu()
})

chrome.downloads.onCreated.addListener((download: any) => {
  void handleDownloadCreated(download)
})

chrome.storage.onChanged.addListener(watchEnabledChanges)

chrome.runtime.onMessage.addListener(onMessagePing)
