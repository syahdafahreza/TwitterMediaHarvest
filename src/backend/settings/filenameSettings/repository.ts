import type { Storage } from 'webextension-polyfill'
import { DEFAULT_DIRECTORY } from '../../../constants'
import { ISettingsRepository } from '../repository'

const defaultFilenameSettings: FilenameSettings = {
  directory: DEFAULT_DIRECTORY,
  no_subdirectory: false,
  filename_pattern: {
    account: true,
    serial: 'order',
  },
}

export default class FilenameSettingsRepository implements ISettingsRepository<FilenameSettings> {
  readonly storageArea: Storage.StorageArea

  constructor(storageArea: Storage.StorageArea) {
    this.storageArea = storageArea
  }

  async getSettings(): Promise<FilenameSettings> {
    const settings = await this.storageArea.get(defaultFilenameSettings)
    return settings as FilenameSettings
  }

  async saveSettings(settings: FilenameSettings): Promise<FilenameSettings> {
    await this.storageArea.set(settings)
    return settings
  }

  async setDefaultSettings(): Promise<void> {
    await this.storageArea.set(defaultFilenameSettings)
  }
}
