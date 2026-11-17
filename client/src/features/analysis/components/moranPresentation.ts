import type { MoranQuadrant } from '../../../services/spatialPivotService';

export const LOCAL_ALPHA = 0.05;
export const MORAN_COLORS: Record<MoranQuadrant, string> = {
  HH: '#b83242', LL: '#345e9e', HL: '#ed9789', LH: '#91bdd8',
};
export const MORAN_LABELS: Record<MoranQuadrant, string> = {
  HH: '高—高', LL: '低—低', HL: '高—低', LH: '低—高',
};
