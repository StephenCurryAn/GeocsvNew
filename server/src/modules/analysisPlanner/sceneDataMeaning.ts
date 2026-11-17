import type { Pool } from 'pg';
import type { DatasetSummary } from '../spatialPivot/datasets';

type FieldMeaning = { label: string; request: RegExp; fields: RegExp };
const fieldMeanings: FieldMeaning[] = [
  { label: '坑洞投诉次数', request: /坑[洞洼]|pothole/i, fields: /pothole|坑[洞洼]/i },
  { label: '服务请求总量', request: /全部(?:服务)?请求|请求总(?:量|数)|总投诉量|total requests/i,
    fields: /total[_ ]requests|请求总(?:量|数)|投诉总数/i },
];

export function requestedFieldMeaning(prompt: string) {
  const meanings = fieldMeanings.filter(meaning => meaning.request.test(prompt));
  return meanings.length === 1 ? meanings[0] : undefined;
}

export function fieldLabel(field: string) {
  return fieldMeanings.find(meaning => meaning.fields.test(field))?.label ?? field;
}

export function requestedMonth(prompt: string) {
  const match = /(?<!\d)(\d{4})\s*(?:年\s*|-)\s*(0?[1-9]|1[0-2])(?:\s*月|(?![\d]))/.exec(prompt.normalize('NFKC'));
  return match && `${match[1]}-${match[2].padStart(2, '0')}`;
}

export async function readSceneDataPeriods(db: Pool, datasets: DatasetSummary[]): Promise<DatasetSummary[]> {
  if (!datasets.length) return datasets;
  const { rows } = await db.query<{ file_id: string; month: string }>(
    'SELECT file_id, month FROM geocsv_analysis_dataset_periods WHERE file_id = ANY($1::text[])',
    [datasets.map(dataset => dataset.fileId)],
  );
  const months = new Map(rows.map(({ file_id, month }) => [file_id, month]));
  return datasets.map(dataset => {
    const dataMonth = months.get(dataset.fileId);
    return dataMonth ? { ...dataset, dataMonth } : dataset;
  });
}
