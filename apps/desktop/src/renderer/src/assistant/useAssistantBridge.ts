import { useEffect } from 'react';

import { platform } from '../platform';
import { useStudio } from '../state/store';
import { toStored, useAssistant } from './store';

/** Quiet time before the conversation is written next to the design. */
const SAVE_DELAY_MS = 1000;
/** The saved conversation comes back once per project, even when the effect runs twice. */
let restored = false;
/** Set before another project opens (B2): its design brings its own conversation. */
let reloadOnNextDesign = false;
/** Writes a conversation change that still waits for its quiet time; set while a design is shown. */
let saveNow: (() => Promise<void>) | null = null;

/**
 * Before another project opens (B2): the conversation of this one is written now, and the next
 * design on screen brings its own.
 */
export async function beforeProjectSwitch(): Promise<void> {
  await saveNow?.();
  reloadOnNextDesign = true;
}

/**
 * Keeps the conversation with the project (decided 2026-11-05): once a design is on screen, the
 * conversation saved with it comes back above anything new; after that every change is written
 * next to the design file, a second after the chat went quiet.
 */
export function useChatPersistence(): void {
  const documentId = useStudio((s) => (s.model.status === 'ready' ? s.model.documentId : null));
  useEffect(() => {
    if (!documentId) return;
    if (reloadOnNextDesign) {
      reloadOnNextDesign = false;
      restored = false;
      useAssistant.getState().reset();
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | null = null;
    const write = () => platform().chat.save(toStored(useAssistant.getState().items));
    saveNow = async () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      await write().catch(() => undefined);
    };
    void platform()
      .chat.load()
      .catch(() => null)
      .then((chat) => {
        if (!live) return;
        if (chat && !restored) useAssistant.getState().restore(chat);
        restored = true;
        // Saving starts only now, so an empty chat never overwrites the saved one.
        off = useAssistant.subscribe((state, previous) => {
          if (state.items === previous.items || state.items.length === 0) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void write().catch(() => undefined);
          }, SAVE_DELAY_MS);
        });
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      saveNow = null;
      off?.();
    };
  }, [documentId]);
}

/** Follows the agent status and event stream from the main process. */
export function useAssistantBridge(): void {
  useEffect(() => {
    void platform().settings.app().then(({ toolDebug }) => {
      useStudio.getState().setToolDebug(toolDebug);
    }).catch(() => undefined);
    const api = platform().agent;
    const offStatus = api.onStatus((status) => {
      useAssistant.getState().setState(status);
    });
    const offEvent = api.onEvent((event) => {
      useAssistant.getState().apply(event);
    });
    void api.status().then((status) => {
      useAssistant.getState().setState(status);
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, []);
}
