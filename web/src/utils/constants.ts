// 文件类型工具：扩展名分类、预览能力判定、图标
export type PreviewKind = 'image' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'text' | 'video' | 'audio' | 'none';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const PDF_EXT = ['pdf'];
const DOC_EXT = ['doc', 'docx'];
const XLS_EXT = ['xls', 'xlsx', 'csv'];
const PPT_EXT = ['ppt', 'pptx'];
const TEXT_EXT = ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml', 'js', 'ts', 'html', 'css', 'java', 'py', 'go', 'sql', 'ini', 'conf', 'sh', 'bat'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];

export function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function getPreviewKind(name: string): PreviewKind {
  const ext = getExt(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (PDF_EXT.includes(ext)) return 'pdf';
  if (DOC_EXT.includes(ext)) return 'doc';
  if (XLS_EXT.includes(ext)) return 'xls';
  if (PPT_EXT.includes(ext)) return 'ppt';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'none';
}

export function isPreviewable(name: string): boolean {
  return getPreviewKind(name) !== 'none';
}

export interface FileCategory {
  color: string;
  label: string;
}

export function getCategory(name: string): FileCategory {
  const kind = getPreviewKind(name);
  switch (kind) {
    case 'image': return { color: '#52c41a', label: '图片' };
    case 'pdf': return { color: '#f5222d', label: 'PDF' };
    case 'doc': return { color: '#1677ff', label: '文档' };
    case 'xls': return { color: '#13c2c2', label: '表格' };
    case 'ppt': return { color: '#fa8c16', label: '演示' };
    case 'video': return { color: '#722ed1', label: '视频' };
    case 'audio': return { color: '#eb2f96', label: '音频' };
    case 'text': return { color: '#8c8c8c', label: '文本' };
    default: return { color: '#595959', label: '文件' };
  }
}

export function isOfficeDoc(name: string): boolean {
  const ext = getExt(name);
  return ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext);
}
