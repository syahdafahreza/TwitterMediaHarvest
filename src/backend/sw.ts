import * as Sentry from '@sentry/browser'
import { Integrations } from '@sentry/tracing'
import { ARIA2_ID } from '../constants'
import Statistics from './libs/Statistics'
import TwitterMediaFile, { DownloadMode } from './libs/TwitterMediaFile'
import { fetchMediaList } from './libs/MediaTweet'
import {
  getExtensionId,
  openOptionsPage,
} from '../libs/chromeApi'
import {
  isDownloadedBySelf,
  isInvalidInfo,
} from './utils/checker'
import DownloadStateUtil from './utils/DownloadStateUtil'
import DownloadRecordUtil from './utils/DownloadRecordUtil'
import {
  downloadItemRecorder,
  fetchDownloadItemRecord,
  fetchFileNameSetting,
  fetchTwitterCt0Cookie,
  initStorage,
  isEnableAria2,
  migrateStorage,
  removeDownloadItemRecord,
} from './helpers/storageHelper'
import {
  notifyDownloadFailed,
  notifyMediaListFetchError,
  notifyUnknownFetchError,
} from './helpers/notificationHelper'
import { Action } from '../typings'

Sentry.init({
  dsn: 'https://40df3cc6025d4968a6275f3aa1a6bbee@o1169684.ingest.sentry.io/6263910',
  integrations: [
    new Integrations.BrowserTracing({
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      routingInstrumentation: () => { },
    }),
  ],
  tracesSampleRate: 1.0,
  environment: process.env.NODE_ENV
})

const enum InstallReason {
  Install = 'install',
  Update = 'update',
}

const processDownloadAction = async (tweetInfo: TweetInfo) => {
  /* eslint-disable no-console */
  if (isInvalidInfo(tweetInfo)) {
    console.error('Invalid tweetInfo.')
    await Statistics.addErrorCount()
    return false
  }
  /* eslint-enable no-console */
  const mediaDownloader = await MediaDownloader.build(tweetInfo)
  const ct0Value = await fetchTwitterCt0Cookie()
  try {
    const mediaList = await fetchMediaList(tweetInfo.tweetId, ct0Value)
    mediaDownloader.downloadMedias(mediaList)
  } catch (reason) {
    Sentry.captureException(reason)
    fetchErrorHandler(
      tweetInfo,
      'status' in reason ?
        reason :
        { status: 500, title: 'InternalError', message: reason }
    )
    throw reason
  }

}

chrome.runtime.onMessage.addListener((message: HarvestMessage, sender, sendRespone) => {
  if (message.action === Action.Download) {
    processDownloadAction(message.data as TweetInfo)
      .then(() => sendRespone({ status: 'success' }))
      .catch((reason) => sendRespone({ status: 'error', data: reason }))

    return true // keep message channel open
  }
})

chrome.runtime.onInstalled.addListener(async details => {
  const reason = details.reason
  const previousVersion = details.previousVersion

  if (reason === InstallReason.Install) await initStorage()
  if (reason === InstallReason.Update) {
    showUpdateMessageInConsole(previousVersion)
    await migrateStorage()
  }

  openOptionsPage()
})

chrome.downloads.onChanged.addListener(async downloadDelta => {
  const isBySelf = await isDownloadedBySelf(downloadDelta.id)
  if (!isBySelf) return false

  const isStateChanged = 'state' in downloadDelta

  if (isStateChanged && isDownloadedBySelf) {
    const { id, endTime, state, error } = downloadDelta
    if (DownloadStateUtil.isInterrupted(state)) {
      const eventTime =
        !error && 'current' in endTime
          ? Date.parse(endTime.current)
          : Date.now()

      await Statistics.addFailedDownloadCount()
      const { info } = await fetchDownloadItemRecord(id)
      notifyDownloadFailed(info, id, eventTime)
    }

    if (DownloadStateUtil.isCompleted(state)) {
      removeDownloadItemRecord(id)
      await Statistics.addSuccessDownloadCount()
    }
  }
})

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const { byExtensionId } = downloadItem
  if (byExtensionId) {
    if (byExtensionId === getExtensionId()) {
      fetchDownloadItemRecord(downloadItem.id).then(record => {
        const { config } = record
        suggest(config as chrome.downloads.DownloadFilenameSuggestion)
      })
      return true
    }
  }
})

chrome.notifications.onClosed.addListener(async notifficationId => {
  if (DownloadRecordUtil.isValidId(notifficationId)) {
    const downloadItemId = DownloadRecordUtil.extractDownloadItemId(notifficationId)
    await removeDownloadItemRecord(downloadItemId)
  }
})

chrome.notifications.onClicked.addListener(async notifficationId => {
  openFailedTweetInNewTab(notifficationId)
})

chrome.notifications.onButtonClicked.addListener(
  async (notifficationId, buttonIndex) => {
    if (buttonIndex === 0) openFailedTweetInNewTab(notifficationId)
    if (buttonIndex === 1) retryDownload(notifficationId as DownloadRecordId)
  }
)

// @ts-expect-error lul
chrome.action.onClicked.addListener(openOptionsPage)

class MediaDownloader {
  public tweetInfo: TweetInfo
  public filenameSetting: FilenameSetting
  public isPassToAria2: boolean
  public mode: DownloadMode
  private record_config: DownloadItemRecorder

  constructor(
    tweetInfo: TweetInfo,
    filenameSetting: FilenameSetting,
    isPassToAria2: boolean
  ) {
    this.tweetInfo = tweetInfo
    this.filenameSetting = filenameSetting
    this.isPassToAria2 = isPassToAria2
    this.mode = this.isPassToAria2 ? DownloadMode.Aria2 : DownloadMode.Browser
    this.record_config = downloadItemRecorder(tweetInfo)
  }

  static async build(tweetInfo: TweetInfo) {
    const fileNameSettings = await fetchFileNameSetting()
    const isPassToAria2 = await isEnableAria2()
    return new MediaDownloader(tweetInfo, fileNameSettings, isPassToAria2)
  }

  downloadMedias(mediaList: string[]) {
    mediaList.forEach((value: string, index: number) => {
      if (!TwitterMediaFile.isValidFileUrl(value)) throw new Error(`Invalid url: ${value}`)

      const mediaFile = new TwitterMediaFile(this.tweetInfo, value, index)
      const config = mediaFile.makeDownloadConfigBySetting(
        this.filenameSetting,
        this.mode
      )

      const downloadCallback = this.record_config(config)
      this.isPassToAria2
        ? chrome.runtime.sendMessage(ARIA2_ID, config)
        : chrome.downloads.download(config, downloadCallback)
    })
  }
}

/* eslint-disable no-console */
function showUpdateMessageInConsole(previous: string) {
  const current = chrome.runtime.getManifest().version
  console.info('The extension has been updated.')
  console.info('Previous version:', previous)
  console.info('Current version:', current)
}
/* eslint-enable no-console */



async function openFailedTweetInNewTab(notifficationId: string) {
  // notificationId is tweet's id
  let tweetId = notifficationId
  if (DownloadRecordUtil.isValidId(notifficationId)) {
    const downloadItemId = DownloadRecordUtil.extractDownloadItemId(notifficationId)
    const { info } = await fetchDownloadItemRecord(downloadItemId)
    tweetId = info.tweetId
    await removeDownloadItemRecord(downloadItemId)
  }

  const url = `https://twitter.com/i/web/status/${tweetId}`
  chrome.tabs.create({ url: url })
}

async function fetchErrorHandler(
  tweetInfo: TweetInfo,
  reason: FetchErrorReason
) {
  let notify
  switch (reason.status) {
    case 429:
      notify = notifyMediaListFetchError
      break

    default:
      notify = notifyUnknownFetchError
      break
  }

  await Statistics.addErrorCount()
  notify(tweetInfo, reason)
}

async function retryDownload(downloadRecordId: DownloadRecordId) {
  const downloadItemId = DownloadRecordUtil.extractDownloadItemId(downloadRecordId)
  const { info, config } = await fetchDownloadItemRecord(downloadItemId)
  await removeDownloadItemRecord(downloadItemId)
  const downloadRecorder = downloadItemRecorder(info)(config)
  chrome.downloads.download(config, downloadRecorder)
}
