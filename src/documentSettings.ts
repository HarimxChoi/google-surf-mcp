export const DOCUMENT_SETTING_KEYS = [
  'SURF_EXTRACT_OCR', 'SURF_EXTRACT_OCR_LANGUAGE', 'SURF_EXTRACT_PDF_FORMAT', 'SURF_EXTRACT_OFFICE_PARSER',
] as const;

export function documentOcrSettings(env: NodeJS.ProcessEnv = process.env): {
  policy: 'off' | 'enabled' | 'auto'; language: string;
} {
  const value = env.SURF_EXTRACT_OCR?.toLowerCase();
  return { policy: value === 'auto' ? 'auto' : value === 'true' ? 'enabled' : 'off',
    language: env.SURF_EXTRACT_OCR_LANGUAGE?.trim() || 'eng' };
}
