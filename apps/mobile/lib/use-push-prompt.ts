import { useCallback, useState } from 'react';
import { useAuth } from './auth-context';
import {
  getPushPermissionStatus,
  hasDeclinedSoftPrompt,
  registerForPushNotifications,
  setDeclinedSoftPrompt,
} from './push';

export type PushPromptState = {
  visible: boolean;
  accept: () => Promise<void>;
  decline: () => void;
};

/**
 * Shows a soft-prompt for push notifications the first time the user
 * creates or joins a tower. Call `trigger()` from the tower create/join
 * success handler; the returned `visible` / `accept` / `decline` drive
 * a bottom sheet or interstitial.
 */
export function usePushPrompt(): PushPromptState & { trigger: () => void } {
  const { apiClient } = useAuth();
  const [visible, setVisible] = useState(false);

  function trigger() {
    (async () => {
      const status = await getPushPermissionStatus();
      if (status === 'granted') return;
      if (await hasDeclinedSoftPrompt()) return;
      setVisible(true);
    })();
  }

  const accept = useCallback(async () => {
    setVisible(false);
    await registerForPushNotifications(apiClient);
  }, [apiClient]);

  const decline = useCallback(() => {
    setVisible(false);
    setDeclinedSoftPrompt();
  }, []);

  return { visible, trigger, accept, decline };
}
