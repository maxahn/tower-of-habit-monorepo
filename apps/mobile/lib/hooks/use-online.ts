import { useEffect, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';

export function useIsOnline(): boolean {
  const [isOnline, setIsOnline] = useState(() => onlineManager.isOnline());

  useEffect(() => {
    return onlineManager.subscribe((online) => {
      setIsOnline(online);
    });
  }, []);

  return isOnline;
}
