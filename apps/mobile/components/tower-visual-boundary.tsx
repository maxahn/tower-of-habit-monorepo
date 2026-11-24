import type { BaseBlockResponse } from '@tower-of-habit/shared';
import { TowerVisual } from '~/components/tower-visual';

interface TowerVisualBoundaryProps {
  height: number;
  blocks: BaseBlockResponse[];
  isCollapsing: boolean;
}

export function TowerVisualBoundary(props: TowerVisualBoundaryProps) {
  return <TowerVisual {...props} />;
}
