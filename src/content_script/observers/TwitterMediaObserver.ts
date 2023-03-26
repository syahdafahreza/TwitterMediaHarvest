import select from 'select-dom'
import makeHarvester from '../core'
import observeElement from './observer'
import { articleHasMedia, isInTweetStatus, isStreamLoaded } from '../utils/checker'

enum Query {
  Root = '#react-root',
  Stream = 'section[role="region"] > div[aria-label] > div',
  Modal = '[aria-labelledby="modal-header"]',
  ModalWrapper = '#layers',
  ModalThread = '[aria-labelledby="modal-header"] [aria-expanded="true"]',
  Timeline = '[data-testid="primaryColumn"] [aria-label]',
}

const revealNsfw = (article: HTMLElement) => {
  if (!article || article.dataset['autoReveal']) return
  const revealButton = select('[style*="blur"]', article)
  if (revealButton) {
    article.dataset['autoReveal'] = 'true'
    revealButton.click()
  }
}

export default class TwitterMediaObserver implements HarvestObserver {
  constructor(readonly autoRevealNsfw = false) {}

  observeRoot() {
    const options: MutationObserverInit = {
      childList: true,
      subtree: true,
    }

    const rootMutationCallback: MutationCallback = (_, observer) => {
      this.initialize()
      if (isStreamLoaded()) {
        this.observeHead()
        this.observeModal()
        this.observeStream()
        this.observeHead()
        observer.disconnect()
      }
    }
    observeElement(Query.Root, rootMutationCallback, options)
  }

  initialize() {
    if (select.exists(Query.Modal) && isInTweetStatus()) {
      const modal = select(Query.Modal)
      makeHarvester(modal)
    }

    const articles = select.all('article')
    for (const article of articles) {
      if (this.autoRevealNsfw) revealNsfw(article)
      if (articleHasMedia(article)) makeHarvester(article)
    }
  }

  observeStream() {
    const mutaionCb: MutationCallback = mutations => {
      for (const mutation of mutations) {
        for (const addedNode of mutation.addedNodes) {
          const article = select('article', addedNode as ParentNode)
          if (this.autoRevealNsfw) revealNsfw(article)
          if (articleHasMedia(article)) makeHarvester(article)
        }
      }
    }

    observeElement(Query.Stream, mutaionCb)
  }

  observeTimeline() {
    observeElement(
      Query.Timeline,
      () => {
        this.initialize()
      },
      { childList: true, subtree: true }
    )
  }

  observeHead() {
    const options: MutationObserverInit = {
      childList: true,
      subtree: false,
    }

    const titleMutationCallback: MutationCallback = () => {
      this.initialize()
      this.observeRoot()
      this.observeTimeline()
    }
    observeElement('head', titleMutationCallback, options)
  }

  observeModal() {
    const options: MutationObserverInit = {
      childList: true,
      subtree: true,
    }

    const threadCallback: MutationCallback = (_, observer) => {
      this.initialize()
      observer.disconnect()
    }

    const modalMutationCallback: MutationCallback = () => {
      this.initialize()
      const modalThread = select(Query.ModalThread)

      if (modalThread) {
        observeElement(modalThread, threadCallback)
      }
    }

    observeElement(Query.ModalWrapper, modalMutationCallback, options)
  }
}
